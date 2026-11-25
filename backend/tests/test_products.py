"""Products are named for what they are; details on manual purchases; receipt lines under Other.

Product categories were removed in November 2026: a product's name (Milk, Coffee)
is its category. These tests lock that nothing about them is left.
"""
import sqlite3
from pantry import core, receipt_read
from .conftest import switch_on_gemini
from .test_receipt_read import PNG, api, settle, submit_message, upload  # noqa: F401 (api is a fixture)


async def test_products_have_no_category(api, db, offices):
    office = offices["Ahmedabad"]
    # The category list and adding a category are gone.
    assert (await api("/api/categories", actor="reader")).status_code == 404
    assert (await api(f"/api/offices/{office}/categories", actor="manager", method="POST", body={"name": "Fruit"})).status_code in (404, 405)
    # A category sent by an older screen is ignored, not stored or echoed.
    made = await api(f"/api/offices/{office}/products", actor="manager", method="POST", body={"name": "Bananas", "category": "Groceries"})
    assert made.status_code == 201 and made.json() == {"productId": made.json()["productId"], "name": "Bananas"}
    product = made.json()["productId"]
    changed = await api(f"/api/products/{product}", actor="manager", method="PATCH", body={"warningEffectiveDays": 7, "category": "Snacks"})
    assert changed.status_code == 200 and changed.json() == {"productId": product, "name": "Bananas"}
    pantry = (await api(f"/api/offices/{office}/pantry", actor="manager")).json()
    assert all("category" not in row for row in pantry["products"])
    assert "category" not in {r["name"] for r in await db.all("PRAGMA table_info(pantry_product)")}
    assert not await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_category'")


async def test_manual_purchase_keeps_mrp_gst_and_discount(api, db, offices):
    office = offices["Ahmedabad"]
    product = (await api(f"/api/offices/{office}/products", actor="manager", method="POST", body={"name": "Green tea"})).json()["productId"]
    body = {"productId": product, "date": "2026-09-18", "packs": 3, "pricePerPack": "120", "mrp": "150", "taxPercent": "18%", "discount": "30"}
    bad = await api(f"/api/offices/{office}/purchases", actor="manager", method="POST", body={**body, "taxPercent": "180"})
    assert bad.status_code == 422 and bad.json()["error"] == "GST is a percent from 0 to 100."
    saved = await api(f"/api/offices/{office}/purchases", actor="manager", method="POST", body=body, headers={"Idempotency-Key": "manual-details-1"})
    assert saved.status_code == 201
    # The same save key with different details is refused, not silently reused.
    other = await api(f"/api/offices/{office}/purchases", actor="manager", method="POST", body={**body, "mrp": "160"}, headers={"Idempotency-Key": "manual-details-1"})
    assert other.status_code == 409
    plain = await api(f"/api/offices/{office}/purchases", actor="manager", method="POST", body={"productId": product, "date": "2026-09-19", "packs": 1, "pricePerPack": "120"})
    assert plain.status_code == 201
    listed = {p["date"]: p for p in (await api(f"/api/offices/{office}/purchases?month=2026-09", actor="manager")).json()["purchases"] if p["product"] == "Green tea"}
    assert (listed["2026-09-18"]["mrp"], listed["2026-09-18"]["taxPercent"], listed["2026-09-18"]["discount"]) == ("150.00", "18", "30.00")
    assert listed["2026-09-18"]["amount"] == "360.00"
    assert not {"mrp", "taxPercent", "discount", "category"} & set(listed["2026-09-19"]) and "category" not in listed["2026-09-18"]


async def test_receipt_lines_that_fit_no_product_go_under_other(api, db, offices, monkeypatch):
    office = offices["Ahmedabad"]

    async def ask(messages, tool_choice):
        return submit_message({"date": "2026-09-18", "lines": [{"printed": "Paper cups (Pack)", "productName": "", "packs": "2", "unitPrice": "50", "lineTotal": "100"}]})

    switch_on_gemini(monkeypatch)
    monkeypatch.setattr(receipt_read, "ask_model", ask)

    async def read():
        started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG))
        await settle()
        path = f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}"
        return path, (await api(path, actor="manager")).json()["result"]["lines"][0]

    path, line = await read()
    # Receipts never add a product named as printed: the line goes under Other.
    assert (line["productId"], line["newName"]) == ("", "Other") and "newCategory" not in line
    keys = ("id", "productId", "newName", "packs", "pricePerPack")
    # A category sent by an older screen is ignored.
    saved = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "lines": [{**{k: line[k] for k in keys}, "newCategory": "Made up"}]})
    assert saved.status_code == 200 and saved.json()["productsAdded"] == ["Other"]
    assert (await db.get("SELECT count(*) AS n FROM pantry_product WHERE name = 'Paper cups (Pack)'"))["n"] == 0
    other = await db.get("SELECT id FROM pantry_product WHERE office_id = ? AND name = 'Other' AND deleted_at IS NULL", office)
    # The next receipt files its stray lines under that same Other product.
    _, line = await read()
    assert (line["productId"], line["productName"], line["newName"], line["matched"]) == (other["id"], "Other", "", False)


async def test_a_database_with_categories_drops_them_and_keeps_its_products(tmp_path):
    file = tmp_path / "old.sqlite"
    with sqlite3.connect(file) as old:
        old.execute("CREATE TABLE pantry_product (id TEXT PRIMARY KEY, office_id TEXT NOT NULL, name TEXT NOT NULL, reorder_level INTEGER NOT NULL, warning_effective_days INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_by TEXT, deleted_at TEXT, category TEXT)")
        old.execute("INSERT INTO pantry_product VALUES ('p1', 'o1', 'Milk', 0, 5, 'someone', '2026-09-01T00:00:00Z', NULL, NULL, 'Dairy')")
        old.execute("CREATE TABLE product_category (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)")
        old.execute("CREATE UNIQUE INDEX product_category_name_lower ON product_category(lower(name))")
        old.execute("INSERT INTO product_category VALUES ('c1', 'Dairy', 'system', '2026-09-01T00:00:00Z')")
    old.close()
    for _ in range(2):
        # Opening twice is safe: the second start finds nothing left to drop.
        database = await core.open_database(file, seed="fixtures")
        try:
            assert "category" not in {r["name"] for r in await database.all("PRAGMA table_info(pantry_product)")}
            assert not await database.get("SELECT name FROM sqlite_master WHERE name IN ('product_category', 'product_category_name_lower')")
            row = await database.get("SELECT id, name, office_id, warning_effective_days FROM pantry_product WHERE id = 'p1'")
            assert dict(row) == {"id": "p1", "name": "Milk", "office_id": "o1", "warning_effective_days": 5}
        finally:
            await database.close()
