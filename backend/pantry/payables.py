"""Payables: what an office owes its suppliers for purchases bought on credit.

A purchase marked on credit adds packs times price per pack to its
supplier's balance. A payment, with its proof of payment, takes it off.
Nothing is hard-deleted: removing a payment sets `deleted_at`, and the
balance goes back up.
"""
from .calc import js_round, today_in_india
from .compat import fixed, number, text
from .core import HttpError, live_person, log, new_id, now, office_by_id, require_view, require_write, scoped, stamp, names_by_id, can_write
from . import calc, inventory, receipts, suppliers
import math
import re

NEED_PROOF = "Attach the payment receipt."


def cents(value):
    return js_round(float(value) * 100)


def rupees(value):
    return fixed(value / 100)


async def credit_rows(db, office_id):
    """Credit purchases at an office as (supplier, date, amount in paise, row)."""
    rows = await db.all("""SELECT u.id, u.purchased_on, u.packs, u.price_per_pack, u.supplier, p.name FROM pantry_purchase u
        JOIN pantry_product p ON p.id = u.product_id
        WHERE p.office_id = ? AND u.deleted_at IS NULL AND u.on_credit = 1 AND u.supplier IS NOT NULL""", office_id)
    return [(r["supplier"], r["purchased_on"], cents(calc.money(r["packs"], r["price_per_pack"])), r) for r in rows]


async def payment_rows(db, office_id):
    return await db.all("SELECT * FROM credit_payment WHERE office_id = ? AND deleted_at IS NULL", office_id)


async def supplier_due(db, office_id, supplier):
    """What the office owes this supplier today, in paise."""
    owed = sum(amount for name, _, amount, _ in await credit_rows(db, office_id) if name == supplier)
    paid = sum(cents(row["amount"]) for row in await payment_rows(db, office_id) if row["supplier"] == supplier)
    return owed - paid


@scoped
async def get_payables(db, person, office_id, month=None):
    person = await live_person(db, person)
    require_view(person, office_id)
    office = await office_by_id(db, office_id)
    if not office:
        raise HttpError(404, "Office not found.")
    today = today_in_india(now())
    selected = inventory.validate_month(month or today[:7])
    start = selected + "-01"
    names = await names_by_id(db)
    figures = {}

    def entry(name):
        return figures.setdefault(name, {"opening": 0, "credit": 0, "paid": 0, "due": 0})

    purchases = []
    for name, day, amount, row in await credit_rows(db, office_id):
        figure = entry(name)
        figure["due"] += amount
        if day < start:
            figure["opening"] += amount
        elif day[:7] == selected:
            figure["credit"] += amount
            purchases.append({"purchaseId": row["id"], "supplier": name, "date": day, "product": row["name"], "packs": row["packs"], "pricePerPack": row["price_per_pack"], "amount": rupees(amount)})
    payments = []
    for row in await payment_rows(db, office_id):
        amount = cents(row["amount"])
        figure = entry(row["supplier"])
        figure["due"] -= amount
        if row["paid_on"] < start:
            figure["opening"] -= amount
        elif row["paid_on"][:7] == selected:
            figure["paid"] += amount
            payments.append({"paymentId": row["id"], "supplier": row["supplier"], "date": row["paid_on"], "amount": rupees(amount), "note": row["note"] or None,
                             "receiptName": row["file_name"], "enteredBy": names.get(row["created_by"], "Unknown"), "createdAt": row["created_at"]})
    rows = []
    for name, figure in figures.items():
        closing = figure["opening"] + figure["credit"] - figure["paid"]
        if not any((figure["opening"], figure["credit"], figure["paid"], figure["due"], closing)):
            continue
        rows.append({"supplier": name, "opening": rupees(figure["opening"]), "credit": rupees(figure["credit"]), "paid": rupees(figure["paid"]), "closing": rupees(closing), "due": rupees(figure["due"])})
    rows.sort(key=lambda r: (-cents(r["due"]), r["supplier"].casefold()))
    payments.sort(key=lambda r: (r["date"], r["createdAt"]), reverse=True)
    purchases.sort(key=lambda r: r["date"], reverse=True)
    for payment in payments:
        payment.pop("createdAt")
    return {
        "officeId": office_id, "officeName": office["name"], "month": selected, "today": today, "canWrite": can_write(person, office_id),
        "due": rupees(sum(f["due"] for f in figures.values())),
        "credit": rupees(sum(f["credit"] for f in figures.values())),
        "paid": rupees(sum(f["paid"] for f in figures.values())),
        "suppliers": rows, "payments": payments, "purchases": purchases,
    }


def parse_amount(value):
    amount = number(value)
    if value == "" or value is None or isinstance(value, bool) or not math.isfinite(amount) or not 0 < amount <= 10_000_000:
        raise HttpError(422, "The amount paid is more than 0 and at most 10000000 INR.")
    return fixed(amount)


@scoped
async def record_payment(db, person, office_id, body, receipt=None):
    """Clear some or all of a supplier's credit. The proof of payment is required."""
    person = await live_person(db, person)
    require_write(person, office_id)
    if not await office_by_id(db, office_id):
        raise HttpError(404, "Office not found.")
    body = body if isinstance(body, dict) else {}
    name = suppliers.clean_supplier(body.get("supplier"))
    if not name:
        raise HttpError(422, "Choose the supplier you paid.")
    paid_on = inventory.parse_date(body.get("date"))
    amount = parse_amount(body.get("amount"))
    note = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f]", " ", text(body.get("note") or ""))).strip()[:200] or None
    data = receipt.get("bytes") if isinstance(receipt, dict) else None
    if not data:
        raise HttpError(422, NEED_PROOF)
    if len(data) > 10 * 1024 * 1024:
        raise HttpError(422, "A receipt is at most 10 MB.")
    content_type = receipts.sniff_receipt(data)
    if not content_type:
        raise HttpError(422, "A receipt is a PDF, JPEG, or PNG.")
    async with db.transaction():
        supplier = await suppliers.find_supplier(db, name)
        due = await supplier_due(db, office_id, supplier) if supplier else 0
        if not supplier or due <= 0:
            raise HttpError(422, f"Nothing is due to {supplier or name} at this office.")
        if cents(amount) > due:
            raise HttpError(422, f"That is more than the ₹{rupees(due)} due to {supplier}.")
        payment_id = new_id()
        extension = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg"}[content_type]
        blob = f"payment-{payment_id}-{new_id()}.{extension}"
        await receipts.store_receipt(blob, data, content_type)
        await db.run("""INSERT INTO credit_payment (id, office_id, supplier, paid_on, amount, note, blob_path, file_name, content_type, byte_size, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", payment_id, office_id, supplier, paid_on, amount, note, blob,
                     receipts.safe_receipt_name(receipt.get("fileName"), blob), content_type, len(data), person["id"], stamp())
        await log(db, person["id"], "payment.create", "payment", payment_id, office_id, f"Paid ₹{amount} to {supplier} on {paid_on}.")
    return {"paymentId": payment_id, "supplier": supplier, "date": paid_on, "amount": amount, "due": rupees(due - cents(amount))}


@scoped
async def delete_payment(db, person, payment_id):
    person = await live_person(db, person)
    async with db.transaction():
        row = await db.get("SELECT * FROM credit_payment WHERE id = ? AND deleted_at IS NULL", payment_id)
        if not row:
            raise HttpError(404, "Payment not found.")
        require_write(person, row["office_id"])
        await db.run("UPDATE credit_payment SET deleted_by = ?, deleted_at = ? WHERE id = ?", person["id"], stamp(), payment_id)
        await log(db, person["id"], "payment.delete", "payment", payment_id, row["office_id"], f"Removed a payment of ₹{row['amount']} to {row['supplier']} from {row['paid_on']}.")
    return {"paymentId": payment_id, "deleted": True}


@scoped
async def payment_file(db, person, payment_id):
    person = await live_person(db, person)
    row = await db.get("SELECT * FROM credit_payment WHERE id = ? AND deleted_at IS NULL", payment_id)
    if not row:
        raise HttpError(404, "Payment not found.")
    require_view(person, row["office_id"])
    try:
        data = await receipts.read_receipt(row["blob_path"])
    except Exception as error:
        if isinstance(error, FileNotFoundError) or getattr(error, "status_code", None) == 404:
            raise HttpError(404, "The receipt file is missing.") from None
        raise
    return {"bytes": data, "contentType": row["content_type"], "fileName": receipts.safe_receipt_name(row["file_name"], "payment")}
