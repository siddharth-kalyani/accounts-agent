import asyncio
import json
from datetime import timedelta
import httpx
import pytest
from pantry import core as c, conversations as conv, chat, gemini, inventory as inv, accounts as a
from .conftest import REAL_GOOGLE_TOKEN, switch_on_gemini
from .test_accounts import fails


async def test_proposals_are_owned_expiring_and_bound_to_thread(db, people, offices):
    manager = people["manager"]
    one = await conv.create_chat_thread(db, manager)
    two = await conv.create_chat_thread(db, manager)
    result = await chat.converse(db, manager, [], "delete coffee at Ahmedabad", thread_id=one["id"])
    proposal = result["proposals"][0]
    assert "will be deleted" in result["reply"] and not result["saved"]
    assert not (await chat.converse(db, manager, [], "yes", thread_id=two["id"]))["saved"]
    with fails(404):
        await conv.confirm_proposal(db, people["other"], proposal["id"], one["id"])
    with fails(404):
        await conv.confirm_proposal(db, manager, proposal["id"], two["id"])
    await conv.add_chat_message(db, manager, one["id"], "assistant", result["reply"], result["proposals"])
    assert (await conv.get_chat_thread(db, manager, one["id"]))["messages"][0]["proposals"]
    future = c.now() + timedelta(minutes=30)
    c.set_clock(lambda: future)
    with fails(404):
        await conv.confirm_proposal(db, manager, proposal["id"], one["id"])
    assert (await conv.get_chat_thread(db, manager, one["id"]))["messages"][0]["proposals"] == []


async def test_delete_no_yes_and_read_only_actor(db, people, offices):
    manager = people["manager"]
    first = await chat.converse(db, manager, [], "delete coffee at Ahmedabad")
    assert first["proposals"]
    assert (await chat.converse(db, manager, [], "no"))["reply"] == "Left unsaved."
    assert any(p["name"] == "Coffee" and not p["deletedAt"] for p in (await inv.get_pantry(db, manager, offices["Ahmedabad"]))["products"])
    assert not (await chat.converse(db, people["reader"], [], "delete coffee at Ahmedabad"))["proposals"]
    await chat.converse(db, manager, [], "delete coffee at Ahmedabad")
    assert (await chat.converse(db, manager, [], "yes"))["saved"]
    product = await db.get("SELECT id, deleted_at FROM pantry_product WHERE office_id = ? AND name = 'Coffee'", offices["Ahmedabad"])
    assert product["deleted_at"]
    for table in ("pantry_purchase", "pantry_count"):
        assert (await db.get(f"SELECT count(*) AS n FROM {table} WHERE product_id = ? AND deleted_at IS NULL", product["id"]))["n"] == 0


@pytest.mark.parametrize("message,table", [("delete the coffee purchase of 10 packs on 8 September at Ahmedabad", "pantry_purchase"), ("delete the coffee shelf count on 20 September at Ahmedabad", "pantry_count")])
async def test_single_row_delete_requires_yes(db, people, offices, message, table):
    before = (await db.get(f"SELECT count(*) AS n FROM {table} WHERE deleted_at IS NULL"))["n"]
    result = await chat.converse(db, people["manager"], [], message)
    assert result["proposals"], result
    assert (await db.get(f"SELECT count(*) AS n FROM {table} WHERE deleted_at IS NULL"))["n"] == before
    assert (await chat.converse(db, people["manager"], [], "yes"))["saved"]
    assert (await db.get(f"SELECT count(*) AS n FROM {table} WHERE deleted_at IS NULL"))["n"] == before - 1


async def test_factual_followup_and_temporary_closure_do_not_call_model(db, people, offices, monkeypatch):
    async def no_model(*args):
        raise AssertionError("A factual query must not call the provider")
    monkeypatch.setattr(chat, "complete", no_model)
    switch_on_gemini(monkeypatch)
    pantry = await inv.get_pantry(db, people["manager"], offices["Ahmedabad"])
    coffee = next(p for p in pantry["products"] if p["name"] == "Coffee")
    question = "how much coffee is left at Ahmedabad?"
    reply = await chat.converse(db, people["manager"], [], question)
    assert coffee["onHand"] in reply["reply"]
    history = [{"role": "user", "content": question}, {"role": "assistant", "content": reply["reply"]}]
    closed = await chat.converse(db, people["manager"], history, "When does it run out if the office is shut for 3 more working days?")
    assert "pantry screen stays" in closed["reply"]
    assert await inv.get_pantry(db, people["manager"], offices["Ahmedabad"]) == pantry


async def test_model_tool_loop_prepares_then_confirms_and_suppresses_premature_saved_claim(db, people, offices, monkeypatch):
    switch_on_gemini(monkeypatch)
    calls = []
    async def model(messages, can_write, on_delta):
        calls.append(messages.copy())
        assert can_write
        if len(calls) == 1:
            return {"content": "", "tool_calls": [{"id": "tool1", "type": "function", "function": {"name": "propose_purchase", "arguments": json.dumps({"office": "Ahmedabad", "product": "Coffee", "packs": 2, "pricePerPack": 10})}}]}
        assert messages[-1]["role"] == "tool"
        return {"content": "I have added the purchase. Done."}
    monkeypatch.setattr(chat, "complete", model)
    count = (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"]
    pieces, replacements = [], []
    result = await chat.converse(db, people["manager"], [], "Add 2 packs of coffee at Ahmedabad for 10 each", on_delta=pieces.append, on_replace=replacements.append)
    assert result["proposals"] and "not saved yet" in result["reply"]
    assert "".join(pieces) == result["reply"] and len(pieces) > 1
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"] == count
    assert (await chat.converse(db, people["manager"], [], "yes"))["saved"]
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"] == count + 1


async def test_model_call_rechecks_live_grants(db, people, monkeypatch):
    switch_on_gemini(monkeypatch)
    calls = 0
    async def model(messages, can_write, on_delta):
        nonlocal calls
        calls += 1
        if calls == 1:
            manager = people["manager"]
            await a.remove_grant(db, people["admin"], manager["id"], manager["grants"][0]["id"])
            return {"tool_calls": [{"id": "tool1", "function": {"name": "propose_product", "arguments": '{"office":"Ahmedabad","name":"Unauthorized"}'}}]}
        assert "error" in json.loads(messages[-1]["content"])
        return {"content": "That could not be prepared."}
    monkeypatch.setattr(chat, "complete", model)
    result = await chat.converse(db, people["manager"], [], "Add a product called Unauthorized at Ahmedabad")
    assert result["proposals"] == []
    assert not await db.get("SELECT id FROM pantry_product WHERE name = 'Unauthorized'")


async def test_streaming_provider_tool_fragments_and_http_failure(monkeypatch):
    switch_on_gemini(monkeypatch)
    real_client = httpx.AsyncClient
    captured = []
    def handler(request):
        captured.append(json.loads(request.content))
        frames = [{"content": "Hello "}, {"content": "world."}, {"tool_calls": [{"index": 0, "id": "a", "function": {"name": "get_", "arguments": '{"office":'}}]}, {"tool_calls": [{"index": 0, "function": {"name": "pantry", "arguments": '"Ahmedabad"}'}}]}]
        content = "\n".join("data: " + json.dumps({"choices": [{"delta": frame}]}) + "\n" for frame in frames) + "data: [DONE]\n"
        return httpx.Response(200, text=content, headers={"content-type": "text/event-stream"})
    requests = []
    def recording(request):
        requests.append(request)
        return handler(request)
    monkeypatch.setattr(chat.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(recording), **kwargs))
    pieces = []
    result = await chat.complete([{"role": "user", "content": "hello"}], False, pieces.append)
    assert "".join(pieces) == "Hello world."
    assert result["tool_calls"][0]["function"] == {"name": "get_pantry", "arguments": '{"office":"Ahmedabad"}'}
    assert not any(t["function"]["name"].startswith("propose_") for t in captured[0]["tools"])
    assert captured[0]["stream"] is True and captured[0]["model"] == "google/gemini-3.1-flash-lite"
    assert captured[0]["reasoning_effort"] == "low" and captured[0]["max_tokens"] == chat.MAX_OUTPUT_TOKENS and "temperature" not in captured[0]
    assert str(requests[0].url) == "https://asia-south1-aiplatform.googleapis.com/v1beta1/projects/synthetic-project/locations/asia-south1/endpoints/openapi/chat/completions"
    assert requests[0].headers["authorization"] == "Bearer synthetic-google-token"
    monkeypatch.setattr(chat.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(lambda _: httpx.Response(503, json={"private": "upstream secret"})), **kwargs))
    with fails(502, "could not reply"):
        await chat.complete([], False, None)


async def test_chat_without_google_credentials_fails_cleanly(monkeypatch):
    switch_on_gemini(monkeypatch)
    def no_credentials():
        raise RuntimeError("no default credentials")
    monkeypatch.setattr(gemini, "_token", no_credentials)
    with fails(502, "could not reply"):
        await chat.complete([{"role": "user", "content": "hello"}], False, None)


def test_gemini_settings_endpoint_and_model_ids(monkeypatch):
    assert not gemini.configured() and not chat.chat_configured()
    monkeypatch.setenv("VERTEX_PROJECT", "synthetic-project")
    monkeypatch.setenv("VERTEX_LOCATION", "global")
    assert gemini.configured() and chat.chat_configured()
    assert gemini.completions_url() == "https://aiplatform.googleapis.com/v1beta1/projects/synthetic-project/locations/global/endpoints/openapi/chat/completions"
    assert gemini.chat_model() == "google/gemini-3.1-flash-lite" and gemini.receipt_model() == "google/gemini-3.8-flash"
    monkeypatch.setenv("GEMINI_CHAT_MODEL", "google/gemini-3.5-flash-lite")
    assert gemini.chat_model() == "google/gemini-3.5-flash-lite"
    monkeypatch.setenv("GEMINI_CHAT_MODEL", "../../other?x=1")
    assert gemini.chat_model() == "google/gemini-3.1-flash-lite"
    monkeypatch.setenv("GEMINI_REASONING_EFFORT", "HIGH")
    assert gemini.reasoning_effort() == "high"
    monkeypatch.setenv("GEMINI_REASONING_EFFORT", "none")
    assert gemini.reasoning_effort() == "low"
    monkeypatch.setenv("VERTEX_LOCATION", "asia-south1/../elsewhere")
    assert not gemini.configured()


def test_google_token_is_cached_and_refreshed_only_when_expired(monkeypatch):
    import google.auth
    calls = {"default": 0, "refresh": 0}
    class Credentials:
        valid, token = False, None
        def refresh(self, request):
            calls["refresh"] += 1
            self.valid, self.token = True, f"token-{calls['refresh']}"
    credentials = Credentials()
    def default(scopes):
        assert scopes == [gemini.SCOPE]
        calls["default"] += 1
        return credentials, "synthetic-project"
    monkeypatch.setattr(google.auth, "default", default)
    monkeypatch.setattr(gemini, "_token", REAL_GOOGLE_TOKEN)
    assert gemini._token() == "token-1" and gemini._token() == "token-1"
    credentials.valid = False
    assert gemini._token() == "token-2"
    assert calls == {"default": 1, "refresh": 2}


async def test_open_screen_is_only_a_fallback_for_the_office(db, people, offices):
    admin = people["admin"]
    assert await chat.factual_reply(db, admin, "how much coffee is left") == "Which office should I use?"
    fallback = await chat.factual_reply(db, admin, "how much coffee is left", context_office_id=offices["Ahmedabad"])
    assert "Ahmedabad" in fallback and "Which office" not in fallback
    named = await chat.factual_reply(db, admin, "how much coffee is left at Pune", context_office_id=offices["Ahmedabad"])
    assert "Pune" in named and "Ahmedabad" not in named
    spent = await chat.factual_reply(db, admin, "how much was spent on coffee", context_office_id=offices["Ahmedabad"], context_month="2026-09")
    assert "September 2026" in spent
