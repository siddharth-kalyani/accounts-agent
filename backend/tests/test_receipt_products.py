"""Receipt reading with Gemini 3 tool calls, new products and printed details."""
import json
import sqlite3
import pytest
from pantry import chat, core, receipt_read
from .conftest import switch_on_gemini
from .test_receipt_read import PNG, api, names, settle, submit_message, upload  # noqa: F401 (api is a fixture)

SIGNATURE = {"google": {"thought_signature": "c2lnbmF0dXJl"}}
KEYS = ("id", "productId", "newName", "packs", "pricePerPack", "mrp", "taxPercent", "discount")


def test_tool_calls_keep_the_gemini_thought_signature():
    message = {"tool_calls": [{"id": "look", "type": "function", "extra_content": SIGNATURE, "function": {"name": "lookup_item", "arguments": "{}"}}]}
    assert receipt_read.tool_calls(message)[0]["extra_content"] == SIGNATURE
    plain = {"tool_calls": [{"id": "look", "type": "function", "function": {"name": "lookup_item", "arguments": "{}"}}]}
    assert "extra_content" not in receipt_read.tool_calls(plain)[0]


async def test_lookup_sends_the_thought_signature_back(monkeypatch):
    # Gemini 3 answers 400 when a function call comes back without its
    # signature, which made every receipt with a lookup fail to read.
    seen = []

    async def ask(messages, tool_choice):
        seen.append(json.loads(json.dumps(messages)))
        if len(seen) == 1:
            return {"tool_calls": [{"id": "look", "type": "function", "extra_content": SIGNATURE, "function": {"name": "lookup_item", "arguments": json.dumps({"printed": "Maggi"})}}]}
        return submit_message({"date": "2026-09-18", "lines": [{"printed": "Maggi", "productName": "", "packs": 1, "unitPrice": "14", "lineTotal": "14"}]})

    async def search(phrase):
        return {"notes": []}

    monkeypatch.setattr(receipt_read, "ask_model", ask)
    monkeypatch.setattr(receipt_read, "search_web", search)
    await receipt_read.extract([b"jpeg"], [])
    assistant = next(m for m in seen[1] if m["role"] == "assistant")
    assert assistant["tool_calls"][0]["extra_content"] == SIGNATURE


async def test_streamed_chat_tool_calls_keep_the_thought_signature():
    chunks = [
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "a", "type": "function", "extra_content": SIGNATURE, "function": {"name": "get_pantry", "arguments": "{}"}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "b", "type": "function", "function": {"name": "get_spend", "arguments": "{}"}}]}}]},
    ]

    class Upstream:
        async def aiter_lines(self):
            for chunk in chunks:
                yield "data: " + json.dumps(chunk)
            yield "data: [DONE]"

    message = await chat.read_model_stream(Upstream(), None)
    first, second = message["tool_calls"]
    assert first["extra_content"] == SIGNATURE and "extra_content" not in second


def test_normalize_keeps_mrp_gst_and_discount_and_files_unmatched_lines_under_other():
    products = [{"id": "milk", "name": "Milk"}, {"id": "marie", "name": "Britannia Marie Gold 250g"}]
    result = receipt_read.normalize({"date": "2026-09-18", "lines": [
        {"printed": "Nescafe Classic 200g", "productName": "", "packs": 2, "pricePerPack": "575", "mrp": "₹650.00", "taxPercent": "9% + 9%", "discount": "-50"},
        {"printed": "Amul Taaza", "productName": "Milk", "packs": 1, "pricePerPack": "66", "mrp": "", "taxPercent": "0", "discount": ""},
        {"printed": "britannia marie gold 250g", "productName": "", "packs": 6, "pricePerPack": "38", "mrp": "40", "taxPercent": "18%", "discount": "0"},
        {"printed": "Odd item", "productName": "", "packs": 1, "pricePerPack": "5", "mrp": "free", "taxPercent": "150", "discount": "10%"},
    ]}, products)
    coffee, milk, marie, odd = result["lines"]
    assert (coffee["mrp"], coffee["taxPercent"], coffee["discount"]) == ("650.00", "18", "50.00")
    assert coffee["productId"] == "" and coffee["newName"] == "Other" and coffee["matched"] is False
    assert milk["productId"] == "milk" and milk["newName"] == "" and milk["taxPercent"] == "0" and milk["mrp"] == ""
    # A product made from an earlier receipt matches its printed name next time.
    assert marie["productId"] == "marie" and marie["newName"] == "" and marie["taxPercent"] == "18"
    assert (odd["mrp"], odd["taxPercent"], odd["discount"]) == ("", "", "")
    # An office that already has Other gets it chosen for unmatched lines.
    result = receipt_read.normalize({"date": "2026-09-18", "lines": [{"printed": "Wall hooks", "productName": "", "packs": 1, "pricePerPack": "49"}]}, [*products, {"id": "other", "name": "other"}])
    assert (result["lines"][0]["productId"], result["lines"][0]["newName"]) == ("other", "")


def test_old_drafts_default_unmatched_lines_to_other():
    line = receipt_read.public_line({"id": "0", "printed": "Maggi 70g", "productId": "", "packs": 1, "pricePerPack": "14.00"})
    assert line["newName"] == "Other" and (line["mrp"], line["taxPercent"], line["discount"]) == ("", "", "")


async def test_unmatched_lines_go_under_other_with_printed_details(api, db, offices, monkeypatch):
    office = offices["Ahmedabad"]
    catalog = await names(db, office)

    async def ask(messages, tool_choice):
        return submit_message({"date": "2026-09-18", "lines": [
            {"printed": "Maggi Noodles 70g", "productName": "", "packs": 4, "unitPrice": "14", "lineTotal": "56", "mrp": "15", "taxPercent": "12", "discount": ""},
            {"printed": "MAGGI NOODLES 70G", "productName": "", "packs": 2, "unitPrice": "14", "lineTotal": "28"},
            {"printed": "Amul Taaza", "productName": "Milk", "packs": 2, "unitPrice": "30", "lineTotal": "50", "discount": "10", "mrp": "34", "taxPercent": "0"},
            {"printed": "Tea leaves", "productName": "", "packs": 1, "unitPrice": "200", "lineTotal": "200"},
        ]})

    switch_on_gemini(monkeypatch)
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG))
    await settle()
    path = f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}"
    lines = (await api(path, actor="manager")).json()["result"]["lines"]
    assert [line["newName"] for line in lines] == ["Other", "Other", "", "Other"]
    assert (lines[2]["mrp"], lines[2]["taxPercent"], lines[2]["discount"], lines[2]["pricePerPack"]) == ("34.00", "0", "10.00", "25.00")
    # Naming a line's product and correcting GST are kept on the draft.
    lines[3] = {**lines[3], "newName": "tea"}
    lines[0] = {**lines[0], "taxPercent": "5"}
    lines = (await api(path, actor="manager", method="PATCH", body={"lines": lines})).json()["result"]["lines"]
    assert lines[3]["newName"] == "tea" and lines[0]["taxPercent"] == "5"

    count = "SELECT count(*) AS n FROM pantry_product WHERE office_id = ?"
    products_before = (await db.get(count, office))["n"]
    purchases_before = (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"]
    bad_lines = [{**{k: line[k] for k in KEYS}, **({"taxPercent": "150"} if line["id"] == "3" else {})} for line in lines]
    bad = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "lines": bad_lines})
    assert bad.status_code == 422 and bad.json()["error"] == "GST is a percent from 0 to 100."
    # A refused approval adds no product and no purchase.
    assert (await db.get(count, office))["n"] == products_before
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase"))["n"] == purchases_before

    saved = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "lines": [{k: line[k] for k in KEYS} for line in lines]})
    assert saved.status_code == 200
    body = saved.json()
    # Both Maggi lines share one Other product; "tea" is the existing Tea, not a duplicate.
    assert body["productsAdded"] == ["Other"]
    assert (await db.get(count, office))["n"] == products_before + 1
    assert [p["product"] for p in body["purchases"]] == ["Other", "Other", "Milk", "Tea"]
    after = await names(db, office)
    assert after["Tea"] == catalog["Tea"] and "Maggi Noodles 70g" not in after
    # Other starts on the receipt date, so all six packs are on hand.
    opening = await db.get("SELECT counted_on, packs FROM pantry_count WHERE product_id = ?", after["Other"])
    assert (opening["counted_on"], opening["packs"]) == ("2026-09-17", 0)
    pantry = (await api(f"/api/offices/{office}/pantry", actor="manager")).json()
    assert float(next(p for p in pantry["products"] if p["name"] == "Other")["onHand"]) == 6

    listed = (await api(f"/api/offices/{office}/purchases?month=2026-09", actor="manager")).json()["purchases"]
    maggi = next(p for p in listed if p["product"] == "Other" and p["packs"] == 4)
    assert (maggi["mrp"], maggi["taxPercent"]) == ("15.00", "5") and "discount" not in maggi
    milk = next(p for p in listed if p["product"] == "Milk" and p["pricePerPack"] == "25.00")
    assert (milk["mrp"], milk["taxPercent"], milk["discount"], milk["amount"]) == ("34.00", "0", "10.00", "50.00")
    logged = await db.get("SELECT summary FROM operation WHERE action = 'product.create' AND entity_id = ?", after["Other"])
    assert logged["summary"] == "Added Other from a receipt."


async def test_a_line_with_no_product_and_no_name_is_still_refused(api, db, offices, monkeypatch):
    office = offices["Ahmedabad"]

    async def ask(messages, tool_choice):
        return submit_message({"date": "2026-09-18", "lines": [{"printed": "Maggi", "productName": "", "packs": 1, "unitPrice": "14", "lineTotal": "14"}]})

    switch_on_gemini(monkeypatch)
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG))
    await settle()
    path = f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}"
    line = (await api(path, actor="manager")).json()["result"]["lines"][0]
    for name in ("", "   "):
        refused = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "lines": [{**{k: line[k] for k in KEYS}, "newName": name}]})
        assert refused.status_code == 422 and refused.json()["error"] == receipt_read.NEED_PRODUCT


async def test_purchase_detail_columns_are_added_to_an_existing_database(tmp_path):
    file = tmp_path / "old.sqlite"
    with sqlite3.connect(file) as old:
        old.execute("CREATE TABLE pantry_purchase (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, purchased_on TEXT NOT NULL, packs INTEGER NOT NULL, price_per_pack TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_by TEXT, deleted_at TEXT)")
        old.execute("INSERT INTO pantry_purchase VALUES ('p1', 'x', '2026-09-01', 2, '10.00', 'someone', '2026-09-01T00:00:00Z', NULL, NULL)")
    old.close()
    database = await core.open_database(file, seed="fixtures")
    try:
        row = await database.get("SELECT * FROM pantry_purchase WHERE id = 'p1'")
        assert row["price_per_pack"] == "10.00" and (row["mrp"], row["tax_percent"], row["discount"]) == (None, None, None)
    finally:
        await database.close()


@pytest.mark.parametrize(("value", "stored"), [("18", "18"), ("12.50%", "12.5"), (" 5 % ", "5"), ("0", "0"), ("", None), (None, None)])
def test_optional_gst_is_a_plain_percent(value, stored):
    from pantry import inventory
    assert inventory.optional_tax(value) == stored


def test_charge_rows_become_adjustments_and_the_bill_balances():
    from pantry.receipt_checks import inspect_receipt, move_charge_lines
    payload = {"receiptTotal": "826.00", "adjustments": [], "lines": [
        {"printed": "Wall Hooks (HSN-39249010)", "productName": "", "packs": "1", "unitPrice": "", "lineTotal": "49.00"},
        {"printed": "Delivery and other charges", "productName": "", "packs": "", "unitPrice": "", "lineTotal": "0.72"},
        {"printed": "Hand Towel (HSN-63026090)", "productName": "", "packs": "1", "unitPrice": "", "lineTotal": "169.00"},
        {"printed": "Delivery & other charges", "productName": "", "packs": "", "unitPrice": "", "lineTotal": "2.49"},
        {"printed": "Sugar 5 kg (HSN-17011490)", "productName": "Sugar", "packs": "1", "unitPrice": "", "lineTotal": "330.00"},
        {"printed": "Handling fee", "productName": "", "packs": "", "unitPrice": "", "lineTotal": "8.79"},
        {"printed": "Wooden Spoon (Pack)", "productName": "", "packs": "2", "unitPrice": "", "lineTotal": "266.00"},
    ]}
    moved = move_charge_lines(payload)
    assert [line["printed"] for line in moved["lines"]] == ["Wall Hooks (HSN-39249010)", "Hand Towel (HSN-63026090)", "Sugar 5 kg (HSN-17011490)", "Wooden Spoon (Pack)"]
    assert [item["amount"] for item in moved["adjustments"]] == ["0.72", "2.49", "8.79"]
    checked, issues = inspect_receipt(moved)
    assert checked["_checks"]["balanced"] is True and not issues
    # A charge whose amount cannot be read leaves the total unchecked rather than balanced.
    unreadable = move_charge_lines({"receiptTotal": "50", "lines": [{"printed": "Wall Hooks", "packs": "1", "lineTotal": "49"}, {"printed": "Delivery charges", "packs": "", "lineTotal": ""}]})
    assert inspect_receipt(unreadable)[0]["_checks"]["balanced"] is False
    # A charge the model matched to an office product is left as a line.
    kept = move_charge_lines({"lines": [{"printed": "Service charge", "productName": "Service", "packs": "1", "lineTotal": "10"}]})
    assert len(kept["lines"]) == 1 and "adjustments" not in kept


def test_new_product_names_leave_out_hsn_codes_and_match_next_time():
    assert receipt_read.new_name("Creative Space Wall Hooks (HSN-39249010)") == "Creative Space Wall Hooks"
    assert receipt_read.new_name("Hand Wash HSN: 34013019 (Pack)") == "Hand Wash (Pack)"
    assert receipt_read.new_name("Tea [SAC 996331]") == "Tea"
    assert receipt_read.new_name("Coffee 200g") == "Coffee 200g"
    result = receipt_read.normalize({"date": "2026-09-18", "lines": [
        {"printed": "Creative Space Wall Hooks (HSN-39249010)", "productName": "", "packs": 1, "pricePerPack": "49"},
    ]}, [{"id": "hooks", "name": "Creative Space Wall Hooks"}])
    assert result["lines"][0]["productId"] == "hooks"


async def test_receipt_with_charge_rows_saves_in_one_approval(api, db, offices, monkeypatch):
    office = offices["Ahmedabad"]

    async def ask(messages, tool_choice):
        return submit_message({"printedDate": "01/10/2026", "date": "", "receiptTotal": "220.72", "adjustments": [], "lines": [
            {"printed": "Wall Hooks (HSN-39249010)", "productName": "", "packs": "1", "unitPrice": "", "lineTotal": "49.00", "mrp": "249", "taxPercent": "18", "discount": "200"},
            {"printed": "Delivery and other charges", "productName": "", "packs": "", "unitPrice": "", "lineTotal": "0.72", "taxPercent": "18"},
            {"printed": "Wooden Spoon (Pack) (HSN-44199090)", "productName": "", "packs": "2", "unitPrice": "", "lineTotal": "171.00", "mrp": "90", "taxPercent": "5"},
        ]})

    switch_on_gemini(monkeypatch)
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    monkeypatch.setattr(receipt_read, "today_in_india", lambda _now: "2026-10-20")
    from pantry import inventory
    monkeypatch.setattr(inventory.calc, "today_in_india", lambda _now: "2026-10-20")
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG))
    await settle()
    path = f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}"
    result = (await api(path, actor="manager")).json()["result"]
    assert [line["newName"] for line in result["lines"]] == ["Other", "Other"]
    # The delivery row is kept as a bill charge, with the printed total.
    assert (result["charges"], result["receiptTotal"]) == ("0.72", "220.72")
    assert "do not match" not in (result["note"] or "")
    saved = await api(path + "/save", actor="manager", method="POST", body={"date": result["date"], "lines": [{k: line[k] for k in KEYS} for line in result["lines"]]})
    assert saved.status_code == 200, saved.json()
    rows = await db.all("SELECT p.name, u.packs, u.price_per_pack, u.mrp, u.tax_percent, u.discount FROM pantry_purchase u JOIN pantry_product p ON p.id = u.product_id WHERE p.office_id = ? AND u.purchased_on = ? ORDER BY p.name, u.packs", office, result["date"])
    # The charge is spread over the prices, so the purchases add up to the printed ₹220.72.
    assert [tuple(row.values()) for row in rows] == [("Other", 1, "49.16", "249.00", "18", "200.00"), ("Other", 2, "85.78", "90.00", "5", None)]
    assert sum(row["packs"] * float(row["price_per_pack"]) for row in rows) == pytest.approx(220.72)


def test_bill_charges_spread_over_the_prices_to_the_printed_total():
    charges = receipt_read.bill_charges([{"label": "Delivery and other charges", "amount": "0.72"}, {"label": "Delivery & other charges", "amount": "2.49"}, {"label": "Handling fee", "amount": "₹8.79"}, {"label": "Unreadable", "amount": "n/a"}])
    assert charges == 1200
    prices = receipt_read.spread_charges([(1, "49.00"), (1, "169.00"), (1, "148.00"), (1, "330.00"), (2, "59.00")], charges)
    assert prices == ["49.72", "171.49", "150.18", "334.87", "59.87"]
    assert sum(round(float(price) * 100) * packs for price, packs in zip(prices, [1, 1, 1, 1, 2])) == 82600
    # A bill discount lowers the prices; no charges leave them as printed.
    assert receipt_read.bill_charges([{"label": "Coupon discount", "amount": "20"}]) == -2000
    assert receipt_read.spread_charges([(2, "50.00")], -2000) == ["40.00"]
    assert receipt_read.spread_charges([(2, "50.00")], 0) == ["50.00"]


async def test_an_old_failed_reading_does_not_come_back(api, offices, monkeypatch):
    office = offices["Ahmedabad"]
    path = f"/api/offices/{office}/receipt-readings"
    # Before Gemini was set up, a reading fails and is never cleared.
    monkeypatch.delenv("VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("VERTEX_LOCATION", raising=False)
    failed = (await api(path, actor="manager", method="POST", body=upload(PNG))).json()["readingId"]
    await settle()
    assert (await api(path + "/open", actor="manager")).json()["reading"]["readingId"] == failed

    async def ask(messages, tool_choice):
        return submit_message({"date": "2026-09-18", "lines": [{"printed": "Tea", "productName": "Tea", "packs": "1", "unitPrice": "10", "lineTotal": "10"}]})

    switch_on_gemini(monkeypatch)
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    later = (await api(path, actor="manager", method="POST", body=upload(PNG))).json()["readingId"]
    await settle()
    assert (await api(path + "/open", actor="manager")).json()["reading"]["readingId"] == later
    assert (await api(f"{path}/{later}/dismiss", actor="manager", method="POST", body={})).status_code == 200
    # Clearing the later receipt does not bring the old failure back.
    assert (await api(path + "/open", actor="manager")).json() == {"reading": None}
