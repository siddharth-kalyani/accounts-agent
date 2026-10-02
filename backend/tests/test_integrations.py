"""External boundaries exercised with real signatures and deterministic transports."""
import hashlib
import json
import os
import stat
import time
from urllib.parse import parse_qs, urlsplit
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from pantry import accounts as a, config, core as c, entra, receipts, secret, migration
from pantry.app import create_app
from pantry.passwords import b64
from .test_accounts import fails

TENANT = "11111111-1111-4111-8111-111111111111"
CLIENT = "22222222-2222-4222-8222-222222222222"
OBJECT = "33333333-3333-4333-8333-333333333333"
ISSUER = f"https://login.microsoftonline.com/{TENANT}/v2.0"
CONFIG = {"issuer": ISSUER, "authorization_endpoint": f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/authorize", "token_endpoint": f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token", "jwks_uri": f"https://login.microsoftonline.com/{TENANT}/discovery/v2.0/keys"}


@pytest.fixture
def microsoft(monkeypatch):
    for key, value in {"ENTRA_TENANT_ID": TENANT, "ENTRA_CLIENT_ID": CLIENT, "ENTRA_CLIENT_SECRET": "synthetic-client-secret", "ENTRA_REDIRECT_URI": "http://127.0.0.1:5173/api/auth/callback"}.items():
        monkeypatch.setenv(key, value)
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key())) | {"kid": "test-key", "use": "sig", "alg": "RS256"}
    class Microsoft:
        nonce = "test-nonce"
        extra = {}
        token_status = 200
        graph_status = 200
        users = []
        requests = []
        def token(self):
            claims = {"iss": ISSUER, "aud": CLIENT, "sub": "synthetic-subject", "iat": int(time.time()), "exp": int(time.time()) + 3600, "nonce": self.nonce, "tid": TENANT, "oid": OBJECT, "acct": 0, "preferred_username": "avery.shah@intuitive.AI", "name": "Avery Shah", "at_hash": b64(hashlib.sha256(b"access-value").digest()[:16])} | self.extra
            return jwt.encode(claims, private, algorithm="RS256", headers={"kid": "test-key"})
        def handle(self, request):
            self.requests.append(request)
            if request.url.path.endswith("openid-configuration"):
                return httpx.Response(200, json=CONFIG)
            if str(request.url) == CONFIG["jwks_uri"]:
                return httpx.Response(200, json={"keys": [public]})
            if str(request.url) == CONFIG["token_endpoint"]:
                form = parse_qs(request.content.decode())
                assert form["client_secret"] == ["synthetic-client-secret"]
                return httpx.Response(self.token_status, json={"id_token": self.token(), "access_token": "access-value", "refresh_token": "refreshed-graph-value"})
            if request.url.host == "graph.microsoft.com":
                assert request.headers["authorization"] == "Bearer access-value"
                assert request.headers["consistencylevel"] == "eventual"
                return httpx.Response(self.graph_status, json={"value": self.users})
            raise AssertionError(f"Unexpected request: {request.url}")
    fake = Microsoft()
    real_client = httpx.AsyncClient
    monkeypatch.setattr(entra.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(fake.handle), **kwargs))
    return fake


async def test_microsoft_pkce_signed_exchange_single_use_and_expiry(db, microsoft):
    started = await entra.begin_sign_in(db, "login")
    query = parse_qs(urlsplit(started["url"]).query)
    microsoft.nonce = query["nonce"][0]
    assert query["scope"] == [entra.LOGIN_SCOPE] and query["prompt"] == ["select_account"]
    result = await entra.finish_sign_in(db, "http://127.0.0.1:5173/api/auth/callback?code=synthetic&state=" + started["state"])
    assert result["identity"] == {"ok": True, "oid": OBJECT, "signInName": "avery.shah@intuitive.AI", "displayName": "Avery Shah"}
    token_request = next(r for r in microsoft.requests if str(r.url) == CONFIG["token_endpoint"])
    verifier = parse_qs(token_request.content.decode())["code_verifier"][0]
    assert query["code_challenge"] == [b64(hashlib.sha256(verifier.encode()).digest())]
    assert await entra.finish_sign_in(db, "http://localhost/?code=x&state=" + started["state"]) == {"error": "expired"}
    started = await entra.begin_sign_in(db, "directory")
    assert "User.ReadBasic.All" in started["url"]
    from datetime import timedelta
    future = c.now() + timedelta(minutes=11)
    c.set_clock(lambda: future)
    assert await entra.finish_sign_in(db, "http://localhost/?code=x&state=" + started["state"]) == {"error": "expired"}


@pytest.mark.parametrize("claims", [{"nonce": "wrong"}, {"iss": "https://attacker.invalid"}, {"aud": "wrong"}, {"exp": 1}, {"iat": 4102444800}, {"tid": "wrong"}, {"oid": "invalid"}, {"acct": 1}, {"preferred_username": "guest@elsewhere.example"}, {"azp": "wrong"}, {"at_hash": "wrong"}])
async def test_microsoft_rejects_invalid_signed_claims(db, microsoft, claims):
    started = await entra.begin_sign_in(db, "login")
    microsoft.nonce = parse_qs(urlsplit(started["url"]).query)["nonce"][0]
    microsoft.extra = claims
    assert "error" in await entra.finish_sign_in(db, "http://localhost/?code=x&state=" + started["state"])


async def test_microsoft_rejects_untrusted_endpoint_algorithm_and_signature(microsoft):
    for url in ("http://login.microsoftonline.com/x", "https://login.microsoftonline.com.attacker.invalid/x", "https://user:pass@login.microsoftonline.com/x", "https://login.microsoftonline.com:444/x"):
        with pytest.raises(ValueError):
            entra.microsoft_endpoint(url)
    async with httpx.AsyncClient() as client:
        token = jwt.encode({"nonce": microsoft.nonce}, "synthetic-unknown-key-of-sufficient-length", algorithm="HS256", headers={"kid": "test-key"})
        with pytest.raises(ValueError):
            await entra.verify_id_token(client, token, CONFIG, entra.entra_settings(), microsoft.nonce)
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        token = jwt.encode({"nonce": microsoft.nonce}, other, algorithm="RS256", headers={"kid": "test-key"})
        with pytest.raises(jwt.InvalidSignatureError):
            await entra.verify_id_token(client, token, CONFIG, entra.entra_settings(), microsoft.nonce)


async def test_graph_refresh_encrypted_rotation_filtering_and_failures(db, people, microsoft):
    issued = await a.begin_browser_session(db, people["admin"]["id"])
    refresh_id = issued["refreshId"]
    with fails(503, "Connect directory"):
        await entra.search_directory(db, refresh_id, "av")
    await a.store_graph_refresh(db, refresh_id, secret.seal("old-graph-value"))
    microsoft.users = [
        {"id": OBJECT, "displayName": "Avery\x00 Shah", "userType": "Member", "userPrincipalName": "avery.shah@intuitive.AI"},
        {"id": CLIENT, "userType": "Guest", "mail": "guest@intuitive.AI"},
        {"id": TENANT, "mail": "outside@example.com"},
        {"id": "not-a-guid", "mail": "invalid@intuitive.AI"},
    ]
    assert await entra.search_directory(db, refresh_id, 'av"\\') == [{"directoryObjectId": OBJECT, "displayName": "Avery Shah", "signInName": "avery.shah@intuitive.AI"}]
    encrypted = await a.graph_refresh_for(db, refresh_id)
    assert "refreshed-graph-value" not in encrypted and secret.unseal(encrypted) == "refreshed-graph-value"
    graph = next(r for r in microsoft.requests if r.url.host == "graph.microsoft.com")
    assert graph.url.params["$search"] == '"displayName:av" OR "mail:av" OR "userPrincipalName:av"'
    for status, expected in [(401, 503), (403, 503), (500, 502)]:
        microsoft.graph_status = status
        with fails(expected):
            await entra.search_directory(db, refresh_id, "av")
    microsoft.token_status = 400
    with fails(503, "consent"):
        await entra.search_directory(db, refresh_id, "av")


async def test_callback_state_allowlist_and_directory_same_account(db, people, monkeypatch):
    real_client = httpx.AsyncClient
    app = create_app(db, load_env=False)
    async with real_client(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:5173") as client:
        assert (await client.get("/api/auth/login")).headers["location"].endswith("?auth=not_configured")
        async def finished(*args):
            return {"purpose": "login", "identity": {"ok": True, "oid": OBJECT, "signInName": "uninvited@intuitive.AI", "displayName": "Uninvited"}, "refreshToken": ""}
        monkeypatch.setattr(entra, "finish_sign_in", finished)
        response = await client.get("/api/auth/callback?code=x&state=matching", headers={"Cookie": "aim_login=wrong"})
        assert response.headers["location"].endswith("?auth=expired")
        response = await client.get("/api/auth/callback?code=x&state=matching", headers={"Cookie": "aim_login=matching"})
        assert response.headers["location"].endswith("?auth=not_on_list")
        async def directory(*args):
            return {"purpose": "directory", "identity": {"signInName": people["admin"]["email"]}, "refreshToken": "synthetic-refresh"}
        monkeypatch.setattr(entra, "finish_sign_in", directory)
        session = await a.begin_browser_session(db, people["admin"]["id"])
        response = await client.get("/api/auth/callback?code=x&state=matching", headers={"Cookie": "aim_login=matching; aim_access=" + session["accessToken"]})
        assert response.headers["location"].endswith("?auth=directory_ready")
        assert secret.unseal(await a.graph_refresh_for(db, session["refreshId"])) == "synthetic-refresh"
        other = await a.begin_browser_session(db, people["reader"]["id"])
        response = await client.get("/api/auth/callback?code=x&state=matching", headers={"Cookie": "aim_login=matching; aim_access=" + other["accessToken"]})
        assert response.headers["location"].endswith("?auth=failed")


async def test_gcs_immutable_receipts_headers_cleanup(monkeypatch, tmp_path):
    monkeypatch.setenv("GCS_RECEIPTS_BUCKET", "synthetic-receipts")
    events, objects = [], {}
    class Blob:
        def __init__(self, name): self.name, self.cache_control, self.content_disposition = name, None, None
        def upload_from_string(self, data, **kwargs):
            assert kwargs == {"content_type": "application/pdf", "if_generation_match": 0, "timeout": 20}
            assert self.cache_control == "no-store" and self.content_disposition == "attachment"
            if self.name in objects: raise receipts.PreconditionFailed("exists")
            objects[self.name] = data
        def download_as_bytes(self, **kwargs): return objects[self.name]
    class Bucket:
        def __init__(self, name): assert name == "synthetic-receipts"
        def blob(self, name): return Blob(name)
    class Client:
        def bucket(self, name): return Bucket(name)
        def close(self): events.append("client.close")
    monkeypatch.setattr(receipts, "_gcs_client", Client)
    await receipts.store_receipt("one.pdf", b"%PDF-test", "application/pdf")
    assert await receipts.read_receipt("one.pdf") == b"%PDF-test"
    with pytest.raises(FileExistsError):
        await receipts.store_receipt("one.pdf", b"replace", "application/pdf")
    assert objects == {"one.pdf": b"%PDF-test"} and events == ["client.close"] * 3
    assert not (tmp_path / "data" / "receipts").exists()
    with pytest.raises(ValueError): await receipts.read_receipt("../one.pdf")


def production_settings(monkeypatch, microsoft=True):
    for k, v in {"APP_ENV": "production", "APP_ORIGIN": "https://pantry.example.com", "SESSION_SECRET": "synthetic-production-secret-" * 3, "DATABASE_URL": "postgresql://synthetic:local@localhost/pantry", "GCS_RECEIPTS_BUCKET": "synthetic-receipts"}.items(): monkeypatch.setenv(k, v)
    if microsoft:
        for k, v in {"ENTRA_TENANT_ID": TENANT, "ENTRA_CLIENT_ID": CLIENT, "SEED_SUPERADMIN_OBJECT_ID": OBJECT, "ENTRA_CLIENT_SECRET": "synthetic-client-secret", "ENTRA_REDIRECT_URI": "https://pantry.example.com/api/auth/callback"}.items(): monkeypatch.setenv(k, v)


@pytest.mark.parametrize("key,value", [("APP_ORIGIN", "http://pantry.example.com"), ("APP_ORIGIN", "https://pantry.example.com/path"), ("SESSION_SECRET", "short"), ("PANTRY_SEED", "fixtures"), ("DATABASE_URL", "sqlite:///file"), ("GCS_RECEIPTS_BUCKET", ""), ("GCS_RECEIPTS_BUCKET", "Not_A_Bucket!"), ("VERTEX_LOCATION", "asia-south1"), ("ENTRA_CLIENT_ID", "not-a-uuid"), ("ENTRA_TENANT_ID", ""), ("SEED_SUPERADMIN_OBJECT_ID", ""), ("ENTRA_CLIENT_SECRET", "short"), ("ENTRA_REDIRECT_URI", "https://elsewhere.example/api/auth/callback")])
def test_production_fails_closed(monkeypatch, key, value):
    production_settings(monkeypatch)
    config.validate_production_config()
    monkeypatch.setenv(key, value)
    with pytest.raises(ValueError): config.validate_production_config()


def test_production_password_only_and_gemini_settings(monkeypatch):
    production_settings(monkeypatch, microsoft=False)
    config.validate_production_config()
    for k, v in {"VERTEX_PROJECT": "synthetic-project", "VERTEX_LOCATION": "asia-south1", "GEMINI_CHAT_MODEL": "gemini-3.1-flash-lite", "GEMINI_RECEIPT_MODEL": "google/gemini-3.8-flash"}.items(): monkeypatch.setenv(k, v)
    config.validate_production_config()
    monkeypatch.setenv("GEMINI_RECEIPT_MODEL", "../other")
    with pytest.raises(ValueError): config.validate_production_config()
    monkeypatch.delenv("GEMINI_RECEIPT_MODEL")
    # Half a Microsoft configuration is refused rather than silently ignored.
    monkeypatch.setenv("ENTRA_CLIENT_ID", CLIENT)
    with pytest.raises(ValueError): config.validate_production_config()


FIRST = "Siddharth.Kalyani@intuitive.AI"


async def test_bootstrap_password_is_a_one_time_first_sign_in(tmp_path, monkeypatch):
    # Padding around the stored secret is ignored; this value also meets the
    # chosen-password rules, so reusing it reaches the "different" check.
    monkeypatch.setenv("BOOTSTRAP_SUPERADMIN_PASSWORD", " Synthetic Bootstrap 1234\n")
    db = await c.open_database(tmp_path / "fresh.sqlite", seed="production")
    try:
        setup = await a.login_with_password(db, FIRST, "Synthetic Bootstrap 1234")
        assert setup["next"] == "setup" and setup["email"] == FIRST
        with fails(422, "different from the invite"):
            await a.complete_password_setup(db, setup["setupToken"], "Synthetic Bootstrap 1234", "Synthetic Bootstrap 1234")
        assert (await a.complete_password_setup(db, setup["setupToken"], "Pantry Door 19", "Pantry Door 19"))["next"] == "app"
        grants = await db.all("SELECT role FROM role_grant WHERE deleted_at IS NULL")
        assert [g["role"] for g in grants] == ["super_admin"]
        # Restarting with the old or a new secret never resets a chosen password.
        for value in ("Synthetic Bootstrap 1234", "another-synthetic-bootstrap"):
            monkeypatch.setenv("BOOTSTRAP_SUPERADMIN_PASSWORD", value)
            async with db.scope():
                await c.seed_production(db)
            with fails(401):
                await a.login_with_password(db, FIRST, value)
        assert (await a.login_with_password(db, FIRST, "Pantry Door 19"))["next"] == "app"
    finally:
        await db.close()


async def test_bootstrap_rearms_only_an_untouched_fresh_install(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_SUPERADMIN_PASSWORD", "synthetic-bootstrap-1234")
    db = await c.open_database(tmp_path / "fresh.sqlite", seed="production")
    token = c.set_clock(lambda: c.parse_stamp("2026-09-28T06:30:00.000Z"))
    try:
        with fails(401, "expired"):
            await a.login_with_password(db, FIRST, "synthetic-bootstrap-1234")
        async with db.scope():
            await c.seed_production(db)
        assert (await a.login_with_password(db, FIRST, "synthetic-bootstrap-1234"))["next"] == "setup"
        monkeypatch.setenv("BOOTSTRAP_SUPERADMIN_PASSWORD", "replacement-synthetic-bootstrap")
        async with db.scope():
            await c.seed_production(db)
        with fails(401):
            await a.login_with_password(db, FIRST, "synthetic-bootstrap-1234")
        assert (await a.login_with_password(db, FIRST, "replacement-synthetic-bootstrap"))["next"] == "setup"
        # Once anyone else exists, the deployment secret changes nothing.
        await db.run("INSERT INTO person (id, sign_in_name, display_name, active) VALUES (?, ?, ?, 1)", c.new_id(), "someone.else@intuitive.AI", "Someone Else")
        monkeypatch.setenv("BOOTSTRAP_SUPERADMIN_PASSWORD", "third-synthetic-bootstrap")
        async with db.scope():
            await c.seed_production(db)
        with fails(401):
            await a.login_with_password(db, FIRST, "third-synthetic-bootstrap")
    finally:
        c._clock.reset(token)
        await db.close()


async def test_password_only_production_needs_a_bootstrap_on_first_start(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(ValueError, match="BOOTSTRAP_SUPERADMIN_PASSWORD"):
        await c.open_database(tmp_path / "first.sqlite", seed="production")
    monkeypatch.setenv("BOOTSTRAP_SUPERADMIN_PASSWORD", "too-short")
    with pytest.raises(ValueError, match="16 to 128"):
        await c.open_database(tmp_path / "second.sqlite", seed="production")


async def test_cloud_sql_socket_url_keeps_socket_and_credentials():
    from psycopg.conninfo import conninfo_to_dict
    from pantry.database import Database
    db = Database(url="postgresql://inventory-agent-user:p%40ss%3Aword@/inventory-db?host=/cloudsql/synthetic-project:asia-south1:inventory-agent")
    try:
        info = conninfo_to_dict(db.pool.conninfo)
        assert info["host"] == "/cloudsql/synthetic-project:asia-south1:inventory-agent"
        assert (info["dbname"], info["user"], info["password"]) == ("inventory-db", "inventory-agent-user", "p@ss:word")
        # libpq ignores sslmode on a Unix socket; Cloud Run's connector encrypts the hop.
        assert info["sslmode"] == "verify-full" and info["connect_timeout"] == "10"
    finally:
        await db.close()


def test_local_secret_persists_and_existing_data_path_is_preserved(tmp_path, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("APP_ENV", "development")
    assert config.production()
    monkeypatch.delenv("SESSION_SECRET")
    secret.ensure_session_secret(tmp_path)
    original = os.environ["SESSION_SECRET"]
    assert len(original) >= 48 and stat.S_IMODE((tmp_path / "session-secret.key").stat().st_mode) == 0o600
    monkeypatch.delenv("SESSION_SECRET")
    secret.ensure_session_secret(tmp_path)
    assert os.environ["SESSION_SECRET"] == original
    monkeypatch.delenv("PANTRY_DATA_DIR")
    monkeypatch.setattr(config, "ROOT", tmp_path)
    assert config.data_directory() == tmp_path / "backend/data"
    (tmp_path / "server/data").mkdir(parents=True)
    assert config.data_directory() == tmp_path / "server/data"


async def test_migration_rejects_fixtures_and_conflicting_immutable_objects(db, tmp_path):
    with pytest.raises(ValueError, match="Demo fixture"):
        migration.inspect_migration(tmp_path / "test.sqlite", tmp_path)
    receipt = {"name": "legacy-test.pdf", "bytes": b"%PDF-one", "contentType": "application/pdf"}
    await migration.upload_once(receipt)
    await migration.upload_once(receipt)
    with pytest.raises(ValueError, match="conflicts"):
        await migration.upload_once(receipt | {"bytes": b"%PDF-two"})
