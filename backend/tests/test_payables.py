"""Several products per purchase, pack sizes, suppliers, credit and Payables."""
import sqlite3
import pytest
from pantry import core, inventory, receipt_read
from pantry.suppliers import supplier_key
from .conftest import switch_on_gemini
from .test_receipt_read import PNG, api, settle, submit_message, upload  # noqa: F401 (api is a fixture)


async def product(api, office, name, category=None):
    body = {"name": name, **({"category": category} if category else {})}
    return (await api(f"/api/offices/{office}/products", actor="manager", method="POST", body=body)).json()["productId"]


def batch(lines, **extra):
    return {"date": "2026-09-18", "supplier": "BLINK COMMERCE PRIVATE LIMITED", "onCredit": True, "lines": lines, **upload(PNG), **extra}


@pytest.mark.parametrize("size, unit, expected", [
    ("", "", (None, None)),
    (None, None, (None, None)),
    ("", "N.A", (None, "N.A")),
    ("500", "ml", ("500", "ml")),
    ("1.50", "ltr", ("1.5", "L")),
    (" 2 ", "KGS", ("2", "kg")),
    ("6", "pieces", ("6", "pcs")),
])
def test_pack_sizes_take_a_listed_unit(size, unit, expected):
    assert inventory.parse_pack(size, unit) == expected


@pytest.mark.parametrize("size, unit, message", [
    ("500", "", "Choose the unit for the pack size."),
    ("", "ml", "Enter the size of one pack"),
    ("0", "ml", "Enter the size of one pack"),
    ("lots", "g", "Enter the size of one pack"),
    ("500", "cups", "Choose the unit from the list"),
    ("12", "N.A", "A pack marked N.A has no size"),
])
def test_pack_sizes_refuse_half_a_size(size, unit, message):
    with pytest.raises(core.HttpError) as refused:
        inventory.parse_pack(size, unit)
    assert refused.value.status == 422 and message in refused.value.message


def test_supplier_names_match_across_spellings():
    assert supplier_key("BLINK COMMERCE PRIVATE LIMITED") == supplier_key("Blink Commerce Pvt. Ltd.")
    assert supplier_key("A & B Traders") == supplier_key("a and b traders")
    assert supplier_key("Blink Commerce") != supplier_key("Blink Commerce Private Limited")


async def test_one_bill_saves_several_products_with_sizes_on_credit(api, db, offices):
    office = offices["Ahmedabad"]
    milk, sticks = await product(api, office, "Toned milk", "Dairy"), await product(api, office, "Stirrers")
    path = f"/api/offices/{office}/purchases/batch"
    lines = [
        {"productId": milk, "packs": 12, "pricePerPack": "27", "packSize": "500", "packUnit": "ml", "onHand": 14},
        {"productId": sticks, "packs": 2, "pricePerPack": "45.5", "packSize": "", "packUnit": "N.A", "mrp": "50"},
    ]
    assert (await api(path, actor="reader", method="POST", body=batch(lines))).status_code == 403
    no_supplier = await api(path, actor="manager", method="POST", body=batch(lines, supplier=" "))
    assert no_supplier.status_code == 422 and no_supplier.json()["error"] == "Choose the supplier for a credit purchase."
    half = await api(path, actor="manager", method="POST", body=batch([{**lines[0], "packUnit": ""}]))
    assert half.status_code == 422 and half.json()["error"] == "Choose the unit for the pack size."
    twice = await api(path, actor="manager", method="POST", body=batch([lines[0], {**lines[0], "onHand": 3}]))
    assert twice.status_code == 422 and "two on-hand counts" in twice.json()["error"]
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase WHERE product_id IN (?, ?)", milk, sticks))["n"] == 0

    saved = await api(path, actor="manager", method="POST", body=batch(lines), headers={"Idempotency-Key": "bill-0001"})
    assert saved.status_code == 201
    result = saved.json()
    assert result["supplier"] == "BLINK COMMERCE PRIVATE LIMITED" and result["onCredit"] is True
    assert [p["product"] for p in result["purchases"]] == ["Toned milk", "Stirrers"] and all(p["receiptSaved"] for p in result["purchases"])
    # A retry with the same key returns the first save; changed details are refused.
    again = await api(path, actor="manager", method="POST", body=batch(lines), headers={"Idempotency-Key": "bill-0001"})
    assert [p["purchaseId"] for p in again.json()["purchases"]] == [p["purchaseId"] for p in result["purchases"]]
    assert (await api(path, actor="manager", method="POST", body=batch(lines, onCredit=False), headers={"Idempotency-Key": "bill-0001"})).status_code == 409
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase WHERE product_id IN (?, ?)", milk, sticks))["n"] == 2

    listed = {p["product"]: p for p in (await api(f"/api/offices/{office}/purchases?month=2026-09", actor="reader")).json()["purchases"]}
    assert (listed["Toned milk"]["packSize"], listed["Toned milk"]["packUnit"], listed["Toned milk"]["supplier"], listed["Toned milk"]["onCredit"]) == ("500", "ml", "BLINK COMMERCE PRIVATE LIMITED", True)
    assert listed["Stirrers"]["packUnit"] == "N.A" and "packSize" not in listed["Stirrers"] and listed["Stirrers"]["mrp"] == "50.00"
    assert listed["Toned milk"]["amount"] == "324.00" and listed["Stirrers"]["amount"] == "91.00"
    count = await db.get("SELECT packs FROM pantry_count WHERE product_id = ? AND counted_on = '2026-09-20'", milk)
    assert count["packs"] == 14
    # A later bill from the same seller, spelled differently, reuses the supplier.
    other = await api(path, actor="manager", method="POST", body=batch([lines[1]], supplier="Blink Commerce Pvt. Ltd.", onCredit=False))
    assert other.json()["supplier"] == "BLINK COMMERCE PRIVATE LIMITED"
    assert (await api("/api/suppliers", actor="reader")).json()["suppliers"] == ["BLINK COMMERCE PRIVATE LIMITED"]


async def test_older_purchases_read_as_before(api, offices):
    office = offices["Ahmedabad"]
    milk = await product(api, office, "Plain milk")
    await api(f"/api/offices/{office}/purchases", actor="manager", method="POST", body={"productId": milk, "date": "2026-09-18", "packs": 1, "pricePerPack": "30"})
    row = next(p for p in (await api(f"/api/offices/{office}/purchases?month=2026-09", actor="manager")).json()["purchases"] if p["product"] == "Plain milk")
    assert not {"packSize", "packUnit", "supplier", "onCredit"} & set(row)


async def test_payables_follow_credit_and_payments_month_by_month(api, db, offices):
    office = offices["Ahmedabad"]
    milk, tea = await product(api, office, "Credit milk"), await product(api, office, "Credit tea")
    path = f"/api/offices/{office}/purchases/batch"
    august = {"productId": milk, "packs": 10, "pricePerPack": "30"}
    assert (await api(path, actor="manager", method="POST", body=batch([august], date="2026-08-30"))).status_code == 201
    assert (await api(path, actor="manager", method="POST", body=batch([{"productId": tea, "packs": 2, "pricePerPack": "150"}]))).status_code == 201
    # Paid at the counter: it is spend, but not owed.
    assert (await api(path, actor="manager", method="POST", body=batch([august], supplier="Corner shop", onCredit=False))).status_code == 201

    view = (await api(f"/api/offices/{office}/payables?month=2026-09", actor="reader")).json()
    assert view["due"] == "600.00" and view["canWrite"] is False
    blink = next(s for s in view["suppliers"] if s["supplier"] == "BLINK COMMERCE PRIVATE LIMITED")
    assert (blink["opening"], blink["credit"], blink["paid"], blink["closing"], blink["due"]) == ("300.00", "300.00", "0.00", "600.00", "600.00")
    assert [s["supplier"] for s in view["suppliers"]] == ["BLINK COMMERCE PRIVATE LIMITED"]
    assert [p["product"] for p in view["purchases"]] == ["Credit tea"]

    pay = f"/api/offices/{office}/payments"
    body = {"supplier": "blink commerce pvt ltd", "date": "2026-09-19", "amount": "250", "note": "UPI ref 42"}
    assert (await api(pay, actor="reader", method="POST", body={**body, **upload(PNG)})).status_code == 403
    proof = await api(pay, actor="manager", method="POST", body=body)
    assert proof.status_code == 422 and proof.json()["error"] == "Attach the payment receipt."
    over = await api(pay, actor="manager", method="POST", body={**body, "amount": "600.01", **upload(PNG)})
    assert over.status_code == 422 and over.json()["error"] == "That is more than the ₹600.00 due to BLINK COMMERCE PRIVATE LIMITED."
    nobody = await api(pay, actor="manager", method="POST", body={**body, "supplier": "Corner shop", **upload(PNG)})
    assert nobody.status_code == 422 and nobody.json()["error"] == "Nothing is due to Corner shop at this office."
    paid = await api(pay, actor="manager", method="POST", body={**body, **upload(PNG, "upi.png")})
    assert paid.status_code == 201 and paid.json()["due"] == "350.00" and paid.json()["supplier"] == "BLINK COMMERCE PRIVATE LIMITED"
    payment_id = paid.json()["paymentId"]

    view = (await api(f"/api/offices/{office}/payables?month=2026-09", actor="manager")).json()
    assert view["due"] == "350.00" and view["paid"] == "250.00" and view["canWrite"] is True
    assert view["payments"][0]["receiptName"] == "upi.png" and view["payments"][0]["note"] == "UPI ref 42"
    blink = view["suppliers"][0]
    assert (blink["opening"], blink["credit"], blink["paid"], blink["closing"]) == ("300.00", "300.00", "250.00", "350.00")
    # August closes at what was owed then; the September payment is not in it.
    august_view = (await api(f"/api/offices/{office}/payables?month=2026-08", actor="manager")).json()
    assert august_view["suppliers"][0]["closing"] == "300.00" and august_view["payments"] == []
    receipt = await api(f"/api/payments/{payment_id}/receipt", actor="reader")
    assert receipt.status_code == 200 and receipt.content == PNG and "attachment" in receipt.headers["content-disposition"]
    assert (await api(f"/api/payments/{payment_id}/receipt", actor="other")).status_code == 404

    assert (await api(f"/api/payments/{payment_id}/delete", actor="reader", method="POST", body={})).status_code == 403
    assert (await api(f"/api/payments/{payment_id}/delete", actor="manager", method="POST", body={})).status_code == 200
    assert (await api(f"/api/offices/{office}/payables?month=2026-09", actor="manager")).json()["due"] == "600.00"
    row = await db.get("SELECT deleted_at, deleted_by FROM credit_payment WHERE id = ?", payment_id)
    assert row["deleted_at"] and row["deleted_by"]
    assert await db.get("SELECT id FROM operation WHERE action = 'payment.delete' AND entity_id = ?", payment_id)
    assert (await api(f"/api/offices/{offices['Pune']}/payables", actor="manager")).status_code == 404


async def test_credit_is_stock_but_not_spend_until_paid(api, db, offices):
    office = offices["Ahmedabad"]
    rice = await product(api, office, "Credit rice")
    path = f"/api/offices/{office}/purchases/batch"

    async def pantry():
        data = (await api(f"/api/offices/{office}/pantry?month=2026-09", actor="manager")).json()
        return data, next(p for p in data["products"] if p["name"] == "Credit rice")

    before, _ = await pantry()
    assert "creditBought" not in before and "creditPaid" not in before
    assert (await api(path, actor="manager", method="POST", body=batch([{"productId": rice, "packs": 4, "pricePerPack": "100"}]))).status_code == 201
    after, row = await pantry()
    # Stock and packs move like any purchase; the amount is owed, not spent.
    assert row["packsAdded"] == 4
    assert (row["spend"], row["creditSpend"]) == ("0.00", "400.00")
    assert after["spend"] == before["spend"] and after["creditBought"] == "400.00"
    # Paying the supplier counts as spend in the month it is paid.
    paid = await api(f"/api/offices/{office}/payments", actor="manager", method="POST", body={"supplier": "BLINK COMMERCE PRIVATE LIMITED", "date": "2026-09-20", "amount": "150", **upload(PNG)})
    assert paid.status_code == 201
    after, row = await pantry()
    assert row["spend"] == "0.00" and after["creditPaid"] == "150.00"
    assert float(after["spend"]) == pytest.approx(float(before["spend"]) + 150)
    summary = (await api("/api/pantry/summary?month=2026-09", actor="admin")).json()
    assert next(o for o in summary["offices"] if o["officeId"] == office)["spend"] == after["spend"]
    # A paid-at-purchase bill is spend at once, as before.
    assert (await api(path, actor="manager", method="POST", body=batch([{"productId": rice, "packs": 1, "pricePerPack": "90"}], onCredit=False))).status_code == 201
    _, row = await pantry()
    assert row["spend"] == "90.00" and row["creditSpend"] == "400.00"


async def test_receipt_reading_proposes_supplier_product_and_pack_size(api, db, offices, monkeypatch):
    office = offices["Ahmedabad"]
    await api(f"/api/offices/{office}/purchases/batch", actor="manager", method="POST", body=batch([{"productId": await product(api, office, "Jaggery"), "packs": 1, "pricePerPack": "50"}], onCredit=False))
    seen = []

    async def ask(messages, tool_choice):
        seen.append(messages[0]["content"])
        return submit_message({"date": "2026-09-18", "supplier": "Blink Commerce Pvt Ltd", "lines": [
            {"printed": "Amul Taaza Toned Milk 500 ml", "productName": "Milk", "packs": "12", "unitPrice": "27", "lineTotal": "324", "packSize": "500", "packUnit": "ml"},
            {"printed": "Wooden stirrers", "productName": "", "packs": "2", "unitPrice": "40", "lineTotal": "80"},
        ]})

    switch_on_gemini(monkeypatch)
    monkeypatch.setattr(receipt_read, "ask_model", ask)
    started = await api(f"/api/offices/{office}/receipt-readings", actor="manager", method="POST", body=upload(PNG))
    await settle()
    # The model picks from the office products only; there is no category list.
    assert "Categories:" not in seen[0] and "- Milk" in seen[0]
    # Extras that are not pantry supplies are filed under Other, not left as loose products.
    assert "go under Other" in seen[0]
    path = f"/api/offices/{office}/receipt-readings/{started.json()['readingId']}"
    result = (await api(path, actor="manager")).json()["result"]
    assert result["supplier"] == "BLINK COMMERCE PRIVATE LIMITED" and result["onCredit"] is True
    milk, stirrers = result["lines"]
    assert (milk["productName"], milk["packSize"], milk["packUnit"]) == ("Milk", "500", "ml")
    # An item that fits no product goes under Other; no size is N.A.
    assert (stirrers["productId"], stirrers["newName"], stirrers["packSize"], stirrers["packUnit"]) == ("", "Other", "", "N.A")

    changed = await api(path, actor="manager", method="PATCH", body={"supplier": "  Local Dairy  ", "onCredit": True, "lines": [{**milk, "packSize": "1", "packUnit": "L"}, stirrers]})
    assert changed.json()["result"]["supplier"] == "Local Dairy" and changed.json()["result"]["lines"][0]["packUnit"] == "L"
    keys = ("id", "productId", "newName", "newCategory", "packs", "pricePerPack", "packSize", "packUnit")
    lines = [{k: line[k] for k in keys} for line in changed.json()["result"]["lines"]]
    no_supplier = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "supplier": "", "onCredit": True, "lines": lines})
    assert no_supplier.status_code == 422 and no_supplier.json()["error"] == "Choose the supplier for a credit purchase."
    saved = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "supplier": "Local Dairy", "onCredit": True, "lines": lines})
    assert saved.status_code == 200
    rows = {r["name"]: r for r in await db.all("SELECT p.name, p.category, u.pack_size, u.pack_unit, u.supplier, u.on_credit FROM pantry_purchase u JOIN pantry_product p ON p.id = u.product_id WHERE u.supplier = 'Local Dairy'")}
    assert set(rows) == {"Milk", "Other"}
    assert (rows["Milk"]["pack_size"], rows["Milk"]["pack_unit"]) == ("1", "L")
    assert rows["Other"]["pack_unit"] == "N.A" and rows["Other"]["on_credit"] == 1
    assert (await api(f"/api/offices/{office}/payables", actor="manager")).json()["due"] == "404.00"


def test_bills_without_a_seller_do_not_start_on_credit():
    result = receipt_read.normalize({"date": "2026-09-18", "lines": [{"printed": "Tea", "productName": "", "packs": 1, "pricePerPack": "5"}]}, [])
    assert (result["supplier"], result["onCredit"]) == ("", False)
    old = receipt_read.public({"id": "r", "status": "ready", "file_name": "old.png", "result_json": '{"date": "2026-09-18", "lines": []}'})
    assert (old["result"]["supplier"], old["result"]["onCredit"]) == ("", False)


async def test_an_existing_database_gets_the_credit_columns(tmp_path):
    file = tmp_path / "old.sqlite"
    with sqlite3.connect(file) as old:
        old.execute("CREATE TABLE pantry_purchase (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, purchased_on TEXT NOT NULL, packs INTEGER NOT NULL, price_per_pack TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_by TEXT, deleted_at TEXT)")
        old.execute("INSERT INTO pantry_purchase VALUES ('u1', 'p1', '2026-09-01', 2, '10.00', 'someone', '2026-09-01T00:00:00Z', NULL, NULL)")
    old.close()
    database = await core.open_database(file, seed="fixtures")
    try:
        row = await database.get("SELECT pack_size, pack_unit, supplier, on_credit FROM pantry_purchase WHERE id = 'u1'")
        assert dict(row) == {"pack_size": None, "pack_unit": None, "supplier": None, "on_credit": None}
        assert (await database.get("SELECT count(*) AS n FROM credit_payment"))["n"] == 0
    finally:
        await database.close()
