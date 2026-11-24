"""Product categories, the inline new product, and details on manual purchases."""
import sqlite3
from pantry import core, receipt_read
from pantry.core import DEFAULT_CATEGORIES
from .conftest import switch_on_gemini
from .test_receipt_read import PNG, api, settle, submit_message, upload  # noqa: F401 (api is a fixture)


async def test_default_categories_are_listed_with_other_last(api):
    assert (await api("/api/categories")).status_code == 401
    listed = (await api("/api/categories", actor="reader")).json()["categories"]
    assert sorted(listed) == sorted(DEFAULT_CATEGORIES) and listed[-1] == "Other"
    assert listed[:-1] == sorted(listed[:-1], key=str.casefold)


async def test_people_who_record_can_add_a_category_once(api, db, offices):
    office = offices["Ahmedabad"]
    path = f"/api/offices/{office}/categories"
    assert (await api(path, actor="reader", method="POST", body={"name": "Fruit"})).status_code == 403
    assert (await api(f"/api/offices/{offices['Pune']}/categories", actor="manager", method="POST", body={"name": "Fruit"})).status_code == 404
    for bad in ("", "   ", "x" * 61):
        refused = await api(path, actor="manager", method="POST", body={"name": bad})
        assert refused.status_code == 422 and refused.json()["error"] == "A category name needs 1 to 60 characters."
    made = await api(path, actor="manager", method="POST", body={"name": "  Fresh   Fruit "})
    assert made.status_code == 201 and made.json() == {"name": "Fresh Fruit", "created": True}
    again = await api(path, actor="manager", method="POST", body={"name": "fresh fruit"})
    assert again.json() == {"name": "Fresh Fruit", "created": False}
    assert (await api(path, actor="manager", method="POST", body={"name": "DAIRY"})).json() == {"name": "Dairy", "created": False}
    listed = (await api("/api/categories", actor="observer")).json()["categories"]
    assert listed.count("Fresh Fruit") == 1 and listed[-1] == "Other"
    logged = await db.get("SELECT summary FROM operation WHERE action = 'category.create'")
    assert logged["summary"] == "Added the category Fresh Fruit."


async def test_products_carry_a_category_from_the_list(api, db, offices):
    office = offices["Ahmedabad"]
    unknown = await api(f"/api/offices/{office}/products", actor="manager", method="POST", body={"name": "Bananas", "category": "Fruit"})
    assert unknown.status_code == 422 and unknown.json()["error"] == "Choose a category from the list."
    assert (await db.get("SELECT count(*) AS n FROM pantry_product WHERE name = 'Bananas'"))["n"] == 0
    made = await api(f"/api/offices/{office}/products", actor="manager", method="POST", body={"name": "Bananas", "category": "groceries"})
    assert made.status_code == 201 and made.json()["category"] == "Groceries"
    plain = await api(f"/api/offices/{office}/products", actor="manager", method="POST", body={"name": "Napkins"})
    assert "category" not in plain.json()
    pantry = (await api(f"/api/offices/{office}/pantry", actor="manager")).json()
    by_name = {p["name"]: p for p in pantry["products"]}
    assert by_name["Bananas"]["category"] == "Groceries" and "category" not in by_name["Napkins"]

    product = made.json()["productId"]
    changed = await api(f"/api/products/{product}", actor="manager", method="PATCH", body={"category": "Snacks"})
    assert changed.status_code == 200 and changed.json()["category"] == "Snacks"
    assert await db.get("SELECT id FROM operation WHERE entity_id = ? AND action = 'product.category'", product)
    # A patch that does not name a category keeps it.
    kept = await api(f"/api/products/{product}", actor="manager", method="PATCH", body={"warningEffectiveDays": 7})
    assert kept.json()["category"] == "Snacks"
    cleared = await api(f"/api/products/{product}", actor="manager", method="PATCH", body={"category": None})
    assert "category" not in cleared.json()
    assert (await db.get("SELECT category FROM pantry_product WHERE id = ?", product))["category"] is None
    assert (await api(f"/api/products/{product}", actor="manager", method="PATCH", body={"category": "Nope"})).status_code == 422
    assert (await api(f"/api/products/{product}", actor="reader", method="PATCH", body={"category": "Dairy"})).status_code in (403, 404)


async def test_manual_purchase_keeps_mrp_gst_and_discount(api, db, offices):
    office = offices["Ahmedabad"]
    product = (await api(f"/api/offices/{office}/products", actor="manager", method="POST", body={"name": "Green tea", "category": "Beverages"})).json()["productId"]
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
    assert (listed["2026-09-18"]["mrp"], listed["2026-09-18"]["taxPercent"], listed["2026-09-18"]["discount"], listed["2026-09-18"]["category"]) == ("150.00", "18", "30.00", "Beverages")
    assert listed["2026-09-18"]["amount"] == "360.00"
    assert not {"mrp", "taxPercent", "discount"} & set(listed["2026-09-19"]) and listed["2026-09-19"]["category"] == "Beverages"


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
    assert (line["productId"], line["newName"], line["newCategory"]) == ("", "Other", "")
    keys = ("id", "productId", "newName", "newCategory", "packs", "pricePerPack")
    refused = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "lines": [{**{k: line[k] for k in keys}, "newCategory": "Made up"}]})
    assert refused.status_code == 422 and refused.json()["error"] == "Choose a category from the list."
    saved = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "lines": [{k: line[k] for k in keys}]})
    assert saved.status_code == 200 and saved.json()["productsAdded"] == ["Other"]
    assert (await db.get("SELECT count(*) AS n FROM pantry_product WHERE name = 'Paper cups (Pack)'"))["n"] == 0
    other = await db.get("SELECT id FROM pantry_product WHERE office_id = ? AND name = 'Other' AND deleted_at IS NULL", office)
    # The next receipt files its stray lines under that same Other product.
    _, line = await read()
    assert (line["productId"], line["productName"], line["newName"], line["matched"]) == (other["id"], "Other", "", False)


async def test_an_existing_database_gets_categories(tmp_path):
    file = tmp_path / "old.sqlite"
    with sqlite3.connect(file) as old:
        old.execute("CREATE TABLE pantry_product (id TEXT PRIMARY KEY, office_id TEXT NOT NULL, name TEXT NOT NULL, reorder_level INTEGER NOT NULL, warning_effective_days INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_by TEXT, deleted_at TEXT)")
        old.execute("INSERT INTO pantry_product VALUES ('p1', 'o1', 'Milk', 0, 5, 'someone', '2026-09-01T00:00:00Z', NULL, NULL)")
    old.close()
    database = await core.open_database(file, seed="fixtures")
    try:
        assert (await database.get("SELECT category FROM pantry_product WHERE id = 'p1'"))["category"] is None
        assert sorted(r["name"] for r in await database.all("SELECT name FROM product_category")) == sorted(DEFAULT_CATEGORIES)
    finally:
        await database.close()
    # Opening again does not seed a second copy.
    database = await core.open_database(file, seed="fixtures")
    try:
        assert (await database.get("SELECT count(*) AS n FROM product_category"))["n"] == len(DEFAULT_CATEGORIES)
    finally:
        await database.close()
