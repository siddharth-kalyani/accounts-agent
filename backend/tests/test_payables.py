"""Several products per purchase, pack sizes, suppliers, credit and Payables."""
import sqlite3
import pytest
from pantry import core, inventory, receipt_read
from pantry.suppliers import supplier_key
from .conftest import switch_on_gemini
from .test_receipt_read import PNG, api, settle, submit_message, upload  # noqa: F401 (api is a fixture)


async def product(api, office, name):
    body = {"name": name}
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
    milk, sticks = await product(api, office, "Toned milk"), await product(api, office, "Stirrers")
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
    keys = ("id", "productId", "newName", "packs", "pricePerPack", "packSize", "packUnit")
    lines = [{k: line[k] for k in keys} for line in changed.json()["result"]["lines"]]
    no_supplier = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "supplier": "", "onCredit": True, "lines": lines})
    assert no_supplier.status_code == 422 and no_supplier.json()["error"] == "Choose the supplier for a credit purchase."
    saved = await api(path + "/save", actor="manager", method="POST", body={"date": "2026-09-18", "supplier": "Local Dairy", "onCredit": True, "lines": lines})
    assert saved.status_code == 200
    rows = {r["name"]: r for r in await db.all("SELECT p.name, u.pack_size, u.pack_unit, u.supplier, u.on_credit FROM pantry_purchase u JOIN pantry_product p ON p.id = u.product_id WHERE u.supplier = 'Local Dairy'")}
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


# Review fixes: balances, payment checks, punctuation suppliers, the CSV and one
# stored receipt per bill.

async def credit_bill(api, office, product_id, supplier, packs, price, date="2026-09-18"):
    saved = await api(f"/api/offices/{office}/purchases/batch", actor="manager", method="POST", body=batch([{"productId": product_id, "packs": packs, "pricePerPack": price}], supplier=supplier, date=date))
    assert saved.status_code == 201, saved.json()
    return saved.json()["purchases"][0]["purchaseId"]


async def pay(api, office, supplier, amount, date="2026-09-20", key=None):
    headers = {"Idempotency-Key": key} if key else None
    return await api(f"/api/offices/{office}/payments", actor="manager", method="POST", body={"supplier": supplier, "date": date, "amount": amount, **upload(PNG)}, headers=headers)


async def test_a_paid_credit_purchase_cannot_be_removed_or_cut_below_its_payments(api, db, offices, people):
    office = offices["Ahmedabad"]
    rice, oil = await product(api, office, "Acme rice"), await product(api, office, "Beta oil")
    acme = await credit_bill(api, office, rice, "Acme", 10, "100")
    await credit_bill(api, office, oil, "Beta Foods", 5, "100")
    assert (await pay(api, office, "Acme", "1000", date="2026-09-19")).status_code == 201
    refused = "Acme was already paid for this credit. Remove or correct that payment on Payables first."
    for path, method, body in [
        (f"/api/purchases/{acme}/delete", "POST", {}),
        (f"/api/purchases/{acme}/hide", "POST", {}),
        (f"/api/purchases/{acme}", "PUT", {"packs": 1}),
        # Moved after the payment, it would have been paid before it was bought.
        (f"/api/purchases/{acme}", "PUT", {"date": "2026-09-20"}),
    ]:
        response = await api(path, actor="manager", method=method, body=body)
        assert response.status_code == 422 and response.json()["error"] == refused, (path, body, response.json())
    # Deleting the product (from chat) is refused the same way.
    with pytest.raises(core.HttpError) as deleted:
        await inventory.delete_product(db, people["manager"], rice)
    assert deleted.value.message == refused
    # Nothing changed: the purchase, its product and both balances stand.
    row = await db.get("SELECT packs, purchased_on, deleted_at FROM pantry_purchase WHERE id = ?", acme)
    assert (row["packs"], row["purchased_on"], row["deleted_at"]) == (10, "2026-09-18", None)
    assert (await db.get("SELECT deleted_at FROM pantry_product WHERE id = ?", rice))["deleted_at"] is None
    view = (await api(f"/api/offices/{office}/payables?month=2026-09", actor="manager")).json()
    assert view["due"] == "500.00" and {s["supplier"]: s["due"] for s in view["suppliers"]} == {"Acme": "0.00", "Beta Foods": "500.00"}
    # Raising the purchase is fine, and once the payment is removed the purchase can go.
    assert (await api(f"/api/purchases/{acme}", actor="manager", method="PUT", body={"packs": 11})).status_code == 200
    payment = view["payments"][0]["paymentId"]
    assert (await api(f"/api/payments/{payment}/delete", actor="manager", method="POST", body={})).status_code == 200
    assert (await api(f"/api/purchases/{acme}/delete", actor="manager", method="POST", body={})).status_code == 200
    assert (await api(f"/api/offices/{office}/payables?month=2026-09", actor="manager")).json()["due"] == "500.00"


def test_balances_are_checked_date_by_date():
    from pantry import payables
    events = [("2026-09-01", 0, 1000), ("2026-09-02", 1, -1000)]
    assert not payables.newly_overpaid(events, events)
    # Removing the credit leaves the ₹10 payment paying for nothing.
    assert payables.newly_overpaid(events, events[1:])
    # Moving the credit after its payment: paid on the 2nd for credit bought on the 3rd.
    assert payables.newly_overpaid(events, [("2026-09-02", 1, -1000), ("2026-09-03", 0, 1000)])
    # Already overpaid on the 1st: raising later credit is fine, cutting it below the payments is not.
    old = [("2026-09-01", 1, -1500), ("2026-09-18", 0, 1000)]
    assert not payables.newly_overpaid(old, [("2026-09-01", 1, -1500), ("2026-09-18", 0, 2000)])
    assert payables.newly_overpaid([("2026-09-01", 1, -1500), ("2026-09-18", 0, 2000)], old)
    assert payables.owed_from(events, "2026-08-31") == 0
    # A later payment already used what was owed then.
    assert payables.owed_from([("2026-09-01", 0, 1000), ("2026-09-10", 1, -1000), ("2026-10-01", 0, 500)], "2026-09-05") == 0
    assert payables.owed_from([("2026-09-01", 0, 1000), ("2026-10-01", 0, 500)], "2026-09-05") == 1000


async def test_an_already_overpaid_supplier_does_not_block_other_edits(api, db, offices):
    office = offices["Ahmedabad"]
    jam = await product(api, office, "Old jam")
    bought = await credit_bill(api, office, jam, "Old Supplier", 1, "100")
    # A payment saved before back-dating was checked: ₹100 paid before the credit.
    await db.run("""INSERT INTO credit_payment (id, office_id, supplier, paid_on, amount, note, blob_path, file_name, content_type, byte_size, created_by, created_at)
        VALUES ('old-payment', ?, 'Old Supplier', '2026-09-01', '150.00', NULL, 'payment-old.png', 'old.png', 'image/png', 1, 'someone', '2026-09-01T00:00:00.000Z')""", office)
    view = (await api(f"/api/offices/{office}/payables?month=2026-09", actor="manager")).json()
    # The supplier is overpaid by ₹50; Due now never counts that as less than nothing.
    assert next(s for s in view["suppliers"] if s["supplier"] == "Old Supplier")["due"] == "-50.00"
    assert float(view["due"]) >= 0
    # Raising the purchase is allowed; lowering it would overpay further and is refused.
    assert (await api(f"/api/purchases/{bought}", actor="manager", method="PUT", body={"packs": 2})).status_code == 200
    lowered = await api(f"/api/purchases/{bought}", actor="manager", method="PUT", body={"packs": 1})
    assert lowered.status_code == 422 and "Old Supplier was already paid" in lowered.json()["error"]


async def test_a_key_reused_for_another_office_is_refused(db, offices, people):
    from pantry import payables
    admin, proof = people["admin"], {"fileName": "p.png", "bytes": PNG}
    for office in offices.values():
        made = await inventory.create_product(db, admin, office, "Key tea")
        await inventory.create_purchases(db, admin, office, {"date": "2026-09-18", "supplier": "Key Traders", "onCredit": True, "lines": [{"productId": made["productId"], "packs": 2, "pricePerPack": "100"}]})
    payment = {"supplier": "Key Traders", "date": "2026-09-20", "amount": "50"}
    first = await payables.record_payment(db, admin, offices["Ahmedabad"], payment, proof, "shared-key-1")
    # The same key and body for another office used to return the first payment
    # and record nothing there.
    with pytest.raises(core.HttpError) as reused:
        await payables.record_payment(db, admin, offices["Pune"], payment, proof, "shared-key-1")
    assert reused.value.status == 409
    assert (await payables.record_payment(db, admin, offices["Ahmedabad"], payment, proof, "shared-key-1")) == first
    # A bill sent with a payment's key is refused too, instead of returning the payment.
    with pytest.raises(core.HttpError) as bill:
        await inventory.create_purchases(db, admin, offices["Ahmedabad"], {"date": "2026-09-18", "lines": [{"productId": (await inventory.create_product(db, admin, offices["Ahmedabad"], "Key sugar"))["productId"], "packs": 1, "pricePerPack": "10"}]}, None, "shared-key-1")
    assert bill.value.status == 409
    assert (await db.get("SELECT count(*) AS n FROM credit_payment WHERE supplier = 'Key Traders'"))["n"] == 1


async def test_payments_round_to_paise_take_commas_and_cannot_predate_the_credit(api, db, offices):
    office = offices["Ahmedabad"]
    tea = await product(api, office, "Dated tea")
    await credit_bill(api, office, tea, "Tea Traders", 1, "1500")
    for amount in ("0.001", "0.004", "0", "-5", "abc"):
        refused = await pay(api, office, "Tea Traders", amount)
        assert refused.status_code == 422 and refused.json()["error"] == "The amount paid is from 0.01 to 10000000 INR.", amount
    assert (await db.get("SELECT count(*) AS n FROM credit_payment WHERE supplier = 'Tea Traders'"))["n"] == 0
    early = await pay(api, office, "Tea Traders", "100", date="2026-09-10")
    assert early.status_code == 422 and early.json()["error"] == "Only ₹0.00 was owed to Tea Traders on 2026-09-10. Check the payment date."
    paid = await pay(api, office, "Tea Traders", "1,000.50", date="2026-09-18")
    assert paid.status_code == 201 and (paid.json()["amount"], paid.json()["due"]) == ("1000.50", "499.50")


async def test_a_payment_retried_with_its_key_is_recorded_once(api, db, offices):
    office = offices["Ahmedabad"]
    sugar = await product(api, office, "Keyed sugar")
    await credit_bill(api, office, sugar, "Sugar House", 2, "200")
    first = await pay(api, office, "Sugar House", "150", key="payment-0001")
    again = await pay(api, office, "Sugar House", "150", key="payment-0001")
    assert first.status_code == 201 and again.status_code == 201 and again.json() == first.json()
    assert (await pay(api, office, "Sugar House", "151", key="payment-0001")).status_code == 409
    assert (await db.get("SELECT count(*) AS n FROM credit_payment WHERE supplier = 'Sugar House'"))["n"] == 1
    assert (await pay(api, office, "Sugar House", "150", key="bad key")).status_code == 422


async def test_a_supplier_name_of_only_punctuation_is_blank(api, db, offices):
    from pantry.suppliers import clean_supplier
    assert [clean_supplier(name) for name in ("-", ".", " # ", "&")] == [None, None, None, "&"]
    office = offices["Ahmedabad"]
    salt = await product(api, office, "Dash salt")
    path = f"/api/offices/{office}/purchases/batch"
    line = [{"productId": salt, "packs": 1, "pricePerPack": "10"}]
    credit = await api(path, actor="manager", method="POST", body=batch(line, supplier="-"))
    assert credit.status_code == 422 and credit.json()["error"] == "Choose the supplier for a credit purchase."
    # Twice in a row used to fail with 500 on the second save.
    for _ in range(2):
        cash = await api(path, actor="manager", method="POST", body=batch(line, supplier="-", onCredit=False))
        assert cash.status_code == 201 and cash.json()["supplier"] is None
    assert not await db.get("SELECT id FROM supplier WHERE name = '-'")


async def test_the_month_csv_adds_up_with_credit_and_payments(api, db, offices):
    import csv
    import io

    async def sheet(office, month):
        response = await api(f"/api/offices/{office}/export?month={month}", actor="manager")
        assert response.status_code == 200
        return list(csv.reader(io.StringIO(response.text.lstrip("﻿"))))

    office = offices["Ahmedabad"]
    plain = await sheet(office, "2026-09")
    # Without credit the file reads as before.
    assert "Credit" not in plain[0] and len(plain[0]) == 8
    flour = await product(api, office, "Sheet flour")
    await credit_bill(api, office, flour, "Mill Co", 2, "99")
    assert (await api(f"/api/offices/{office}/purchases/batch", actor="manager", method="POST", body=batch([{"productId": flour, "packs": 1, "pricePerPack": "40"}], onCredit=False))).status_code == 201
    assert (await pay(api, office, "Mill Co", "50")).status_code == 201
    rows = await sheet(office, "2026-09")
    assert rows[0][-2:] == ["On credit (INR)", "Supplier"] and all(len(row) == 10 for row in rows)
    body, total = rows[1:-1], rows[-1]
    assert total[0] == "Office total"
    # The Amount column adds up to the office total: what was spent, with the
    # month's payments as rows. Credit purchases sit under On credit instead.
    assert float(total[4]) == pytest.approx(sum(float(row[4]) for row in body if row[4]))
    assert [row[0] for row in body if row[0].startswith("Payment to")] == ["Payment to Mill Co"]
    owed = [row for row in body if row[8] and not row[0].startswith("Bought on credit")]
    assert [(row[0], row[4], row[8], row[9]) for row in owed] == [("Sheet flour", "", "198.00", "Mill Co")]
    pantry = (await api(f"/api/offices/{office}/pantry?month=2026-09", actor="manager")).json()
    assert total[4] == pantry["spend"]
    credit_total = next(row for row in body if row[0].startswith("Bought on credit"))
    assert credit_total[8] == pantry["creditBought"] and float(credit_total[8]) == pytest.approx(sum(float(row[8]) for row in owed))


async def test_one_bill_stores_its_receipt_once(api, db, offices, people, monkeypatch):
    from pantry import receipts
    office = offices["Ahmedabad"]
    ids = [await product(api, office, f"Shared receipt {n}") for n in "abc"]
    stored = []
    original = receipts.store_receipt

    async def counting(name, data, content_type):
        stored.append(name)
        await original(name, data, content_type)

    monkeypatch.setattr(receipts, "store_receipt", counting)
    saved = await api(f"/api/offices/{office}/purchases/batch", actor="manager", method="POST", body=batch([{"productId": p, "packs": 1, "pricePerPack": "10"} for p in ids]))
    assert saved.status_code == 201 and all(p["receiptSaved"] for p in saved.json()["purchases"])
    assert len(stored) == 1
    purchases = [p["purchaseId"] for p in saved.json()["purchases"]]
    rows = await db.all(f"SELECT blob_path FROM pantry_receipt WHERE purchase_id IN ({', '.join('?' for _ in purchases)})", *purchases)
    assert len(rows) == 3 and {r["blob_path"] for r in rows} == {stored[0]}
    for purchase_id in purchases:
        download = await api(f"/api/purchases/{purchase_id}/receipt", actor="manager")
        assert download.status_code == 200 and download.content == PNG
    # A retry that overlapped the first upload attaches nothing twice, and a
    # purchase removed during the upload does not get its receipt back.
    from pantry import inventory as inv
    await db.run("UPDATE pantry_purchase SET deleted_at = '2026-09-20T00:00:00.000Z', deleted_by = 'someone' WHERE id = ?", purchases[2])
    await db.run("UPDATE pantry_receipt SET deleted_at = '2026-09-20T00:00:00.000Z', deleted_by = 'someone' WHERE purchase_id = ?", purchases[2])
    before = (await db.get("SELECT count(*) AS n FROM operation WHERE action LIKE 'receipt.%'"))["n"]
    await inv.attach_bill_receipt(db, people["manager"], purchases, {"blob": "bill-late.png", "fileName": "late.png", "contentType": "image/png", "size": len(PNG)}, "2026-09-20T00:00:00.000Z", only_missing=True)
    assert (await db.get("SELECT count(*) AS n FROM operation WHERE action LIKE 'receipt.%'"))["n"] == before
    assert (await db.get("SELECT deleted_at FROM pantry_receipt WHERE purchase_id = ?", purchases[2]))["deleted_at"]
    assert {r["blob_path"] for r in await db.all("SELECT blob_path FROM pantry_receipt WHERE purchase_id IN (?, ?)", purchases[0], purchases[1])} == {stored[0]}
    # Replacing one purchase's receipt leaves the others on the shared file.
    assert (await api(f"/api/purchases/{purchases[0]}/receipt", actor="manager", method="PUT", body=upload(PNG, "new.png"))).status_code == 200
    assert (await db.get("SELECT blob_path FROM pantry_receipt WHERE purchase_id = ?", purchases[1]))["blob_path"] == stored[0]
    assert (await db.get("SELECT blob_path FROM pantry_receipt WHERE purchase_id = ?", purchases[0]))["blob_path"] != stored[0]


def test_chat_reports_credit_beside_spend_as_stock_does():
    from pantry.chat import describe_product
    milk = {"name": "Milk", "spend": "360.00", "creditSpend": "500.00"}
    assert describe_product("Ahmedabad", milk, "2026-09", "what did we spend on milk") == (
        "Ahmedabad has spent ₹360.00 on Milk in September 2026. Another ₹500.00 was bought on credit. It counts as spend when the supplier is paid.")
    assert describe_product("Ahmedabad", {"name": "Milk", "spend": "360.00"}, "2026-09", "what did we spend on milk") == "Ahmedabad has spent ₹360.00 on Milk in September 2026."


async def test_chat_office_spend_reports_credit(api, db, offices, people):
    from pantry import chat
    office = offices["Ahmedabad"]
    await credit_bill(api, office, await product(api, office, "Chat biscuits"), "Biscuit Co", 3, "100")
    reply = await chat.factual_reply(db, people["manager"], "How much did Ahmedabad spend?", context_month="2026-09")
    assert reply.endswith("Another ₹300.00 was bought on credit. It counts as spend when the supplier is paid."), reply


async def test_migration_copies_suppliers_and_payment_proofs(tmp_path):
    from pantry import accounts, migration, payables
    from pantry.config import data_directory
    file = tmp_path / "source.sqlite"
    source = await core.open_database(file, seed="production")
    try:
        admin = (await accounts.sign_in(source, "Siddharth.Kalyani@intuitive.AI"))["person"]
        office = await inventory.create_office(source, admin, "Migration office")
        made = await inventory.create_product(source, admin, office["id"], "Biscuits")
        await inventory.create_purchases(source, admin, office["id"], {"date": "2026-09-18", "supplier": "Acme", "onCredit": True, "lines": [{"productId": made["productId"], "packs": 2, "pricePerPack": "50"}]})
        await payables.record_payment(source, admin, office["id"], {"supplier": "Acme", "date": "2026-09-20", "amount": "40"}, {"fileName": "upi.png", "bytes": PNG})
    finally:
        await source.close()
    # A backup taken while products still had categories: the copy leaves them out.
    with sqlite3.connect(file) as old:
        old.execute("ALTER TABLE pantry_product ADD COLUMN category TEXT")
        old.execute("UPDATE pantry_product SET category = 'Snacks'")
        old.execute("CREATE TABLE product_category (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)")
        old.execute("INSERT INTO product_category VALUES ('c1', 'Snacks', 'system', '2026-09-01T00:00:00Z')")
    old.close()
    snapshot = migration.inspect_migration(file, data_directory() / "receipts")
    assert (snapshot["counts"]["supplier"], snapshot["counts"]["credit_payment"]) == (1, 1) and "product_category" not in snapshot["counts"]
    proof = snapshot["rows"]["credit_payment"][0]["blob_path"]
    assert proof.startswith("legacy-payment-") and any(r["name"] == proof and r["bytes"] == PNG for r in snapshot["receipts"])
    # The SQLite target stands in for PostgreSQL, which this check does not need.
    target = await core.open_database(tmp_path / "target.sqlite", seed="none")
    try:
        target.dialect = "postgres"
        assert await migration.migrate_snapshot(target, snapshot) == snapshot["counts"]
        assert (await target.get("SELECT name FROM supplier"))["name"] == "Acme"
        moved = await target.get("SELECT supplier, amount, blob_path FROM credit_payment")
        assert (moved["supplier"], moved["amount"], moved["blob_path"]) == ("Acme", "40.00", proof)
        assert "Biscuits" in {r["name"] for r in await target.all("SELECT name FROM pantry_product")}
        assert "category" not in {r["name"] for r in await target.all("PRAGMA table_info(pantry_product)")}
    finally:
        await target.close()
    # A backup from before suppliers and payments copies none of them.
    with sqlite3.connect(file) as old:
        for table in ("supplier", "credit_payment"):
            old.execute(f"DROP TABLE {table}")
    old.close()
    older = migration.inspect_migration(file, data_directory() / "receipts")
    assert (older["counts"]["supplier"], older["counts"]["credit_payment"]) == (0, 0)


async def test_a_supplier_added_from_the_picker_is_saved_at_once(api, db, offices):
    office = offices["Ahmedabad"]
    path = f"/api/offices/{office}/suppliers"
    added = await api(path, actor="manager", method="POST", body={"name": "  Corner   Shop Pvt. Ltd. "})
    assert added.status_code == 201 and added.json() == {"name": "Corner Shop Pvt. Ltd.", "created": True}
    # Listed for every office straight away, before any bill names it.
    assert (await api("/api/suppliers", actor="reader")).json()["suppliers"] == ["Corner Shop Pvt. Ltd."]
    # Another spelling of a listed supplier returns that one instead of adding a second.
    again = await api(path, actor="admin", method="POST", body={"name": "corner shop private limited"})
    assert again.status_code == 201 and again.json() == {"name": "Corner Shop Pvt. Ltd.", "created": False}
    assert (await db.get("SELECT count(*) AS n FROM supplier"))["n"] == 1
    assert (await db.get("SELECT count(*) AS n FROM operation WHERE action = 'supplier.create' AND office_id = ?", office))["n"] == 1
    for name in ("", " - ", None, "x" * 121):
        assert (await api(path, actor="manager", method="POST", body={"name": name})).status_code == 422
    # Only people who can record purchases at that office can add one.
    assert (await api(path, actor="reader", method="POST", body={"name": "Reader shop"})).status_code in (403, 404)
    assert (await api(path, actor="observer", method="POST", body={"name": "Observer shop"})).status_code == 403
    assert (await api(f"/api/offices/{offices['Pune']}/suppliers", actor="manager", method="POST", body={"name": "Pune shop"})).status_code == 404
    assert (await api("/api/offices/no-such-office/suppliers", actor="admin", method="POST", body={"name": "Ghost shop"})).status_code == 404
    assert (await api("/api/suppliers", actor="reader")).json()["suppliers"] == ["Corner Shop Pvt. Ltd."]
    # A bill naming it later reuses the listed name.
    rice = await product(api, office, "Picker rice")
    saved = await api(f"/api/offices/{office}/purchases/batch", actor="manager", method="POST", body=batch([{"productId": rice, "packs": 1, "pricePerPack": "10"}], supplier="CORNER SHOP PVT LTD"))
    assert saved.status_code == 201 and saved.json()["supplier"] == "Corner Shop Pvt. Ltd."
