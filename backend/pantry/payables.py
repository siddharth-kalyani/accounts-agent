"""Payables: what an office owes its suppliers for purchases bought on credit.

A purchase marked on credit adds packs times price per pack to its
supplier's balance. A payment, with its proof of payment, takes it off.
Nothing is hard-deleted: removing a payment sets `deleted_at`, and the
balance goes back up.
"""
from .calc import js_round, today_in_india
from .compat import dumps, fixed, number, text
from .core import HttpError, live_person, log, new_id, now, office_by_id, require_view, require_write, scoped, stamp, names_by_id, can_write
from . import calc, inventory, receipts, suppliers
import hashlib
import json
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


async def supplier_events(db, office_id, supplier):
    """Credit (+) and payments (-) with one supplier as (date, order, paise), oldest first.
    On one day, credit comes before payments."""
    events = [(day, 0, amount) for name, day, amount, _ in await credit_rows(db, office_id) if name == supplier]
    events += [(row["paid_on"], 1, -cents(row["amount"])) for row in await payment_rows(db, office_id) if row["supplier"] == supplier]
    return sorted(events)


def owed_from(events, day):
    """What was owed on `day` and stayed owed after it: the lowest running balance
    from the end of that day on. A payment dated `day` can be at most this."""
    balance = sum(amount for when, _, amount in events if when <= day)
    lowest = balance
    for when, _, amount in events:
        if when > day:
            balance += amount
            lowest = min(lowest, balance)
    return lowest


def day_balances(events):
    """What was owed at the end of each day with an event, in paise. Credit
    comes before payments on a day, so the end of the day is its lowest point."""
    balances, balance = {}, 0
    for when, _, amount in events:
        balance += amount
        balances[when] = balance
    return balances


def newly_overpaid(before, after):
    """Whether `after` leaves any day paid more than was bought on credit, and by
    more than `before` did. A balance that was already off (an older
    back-dated payment) does not block a change that does not make it worse."""
    was, now = day_balances(before), day_balances(after)
    then = later = 0
    for day in sorted(set(was) | set(now)):
        then, later = was.get(day, then), now.get(day, later)
        if later < 0 and later < then:
            return True
    return False


async def credit_before(db, office_id, names):
    """Each named supplier's credit and payments, taken before a change to its credit."""
    return {supplier: await supplier_events(db, office_id, supplier) for supplier in sorted({name for name in names if name})}


async def check_paid_within_credit(db, office_id, before):
    """Refuse a change to credit purchases that leaves a supplier paid more than
    was bought on credit by some date. The caller's transaction rolls it back."""
    for supplier, events in before.items():
        if newly_overpaid(events, await supplier_events(db, office_id, supplier)):
            raise HttpError(422, f"{supplier} was already paid for this credit. Remove or correct that payment on Payables first.")


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
        # What is owed: a supplier can never be owed less than nothing.
        "due": rupees(sum(max(f["due"], 0) for f in figures.values())),
        "credit": rupees(sum(f["credit"] for f in figures.values())),
        "paid": rupees(sum(f["paid"] for f in figures.values())),
        "suppliers": rows, "payments": payments, "purchases": purchases,
    }


def parse_amount(value):
    if isinstance(value, str):
        # Typed amounts can carry separators or the rupee sign: "1,00,000", "₹ 400".
        value = re.sub(r"[,\s₹]", "", value)
    amount = number(value)
    # Checked after rounding to paise, so 0.001 is not saved as a ₹0.00 payment.
    if value == "" or value is None or isinstance(value, bool) or not math.isfinite(amount) or not 0 < amount <= 10_000_000 or cents(fixed(amount)) < 1:
        raise HttpError(422, "The amount paid is from 0.01 to 10000000 INR.")
    return fixed(amount)


def payment_hash(office_id, body, receipt):
    # The office and kind are part of the request, so a key reused for another
    # office (or for a bill) is refused instead of returning this payment.
    receipt_hash = hashlib.sha256(receipt["bytes"]).hexdigest() if isinstance(receipt, dict) and receipt.get("bytes") else ""
    payload = {k: body[k] for k in ("supplier", "date", "amount", "note") if k in body}
    return hashlib.sha256(dumps({**payload, "receipt": receipt_hash, "officeId": office_id, "kind": "payment"}).encode()).hexdigest()


async def record_payment(db, person, office_id, body, receipt=None, idempotency=None):
    """Clear some or all of a supplier's credit. The proof of payment is required.

    Honors an `Idempotency-Key`, as purchases do: a retry after a lost response
    returns the first payment instead of paying twice.

    Everything is checked first; the proof is then stored without holding the
    database lock, and the payment is checked again and saved in one
    transaction. A payment refused at that point leaves only an unused proof
    object behind, never a payment without its proof.
    """
    checked = await _payment_request(db, person, office_id, body, receipt, idempotency, save=None)
    if "result" in checked:
        return checked["result"]
    extension = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg"}[checked["contentType"]]
    blob = f"payment-{checked['paymentId']}-{new_id()}.{extension}"
    await receipts.store_receipt(blob, checked["data"], checked["contentType"])
    return (await _payment_request(db, person, office_id, body, receipt, idempotency, save={**checked, "blob": blob}))["result"]


@scoped
async def _payment_request(db, person, office_id, body, receipt, idempotency, save):
    """Check a payment (save is None), or check it again and save it with its
    stored proof. Returns the checked request, or {"result": payment}."""
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
    key = text(idempotency or "").strip()
    if key and not re.fullmatch(r"[A-Za-z0-9._:-]{8,200}", key):
        raise HttpError(422, "The save key is not valid. Retry the payment.")
    hashed = payment_hash(office_id, body, receipt) if key else ""
    async with db.transaction():
        prior = await db.get("SELECT request_hash, body FROM idempotency WHERE person_id = ? AND key = ?", person["id"], key) if key else None
        if prior:
            if prior["request_hash"] != hashed:
                raise HttpError(409, "This save was already sent with different details.")
            return {"result": json.loads(prior["body"])}
        supplier = await suppliers.find_supplier(db, name)
        due = await supplier_due(db, office_id, supplier) if supplier else 0
        if not supplier or due <= 0:
            raise HttpError(422, f"Nothing is due to {supplier or name} at this office.")
        if cents(amount) > due:
            raise HttpError(422, f"That is more than the ₹{rupees(due)} due to {supplier}.")
        # A back-dated payment can only clear what was already owed on its date.
        owed = owed_from(await supplier_events(db, office_id, supplier), paid_on)
        if cents(amount) > owed:
            raise HttpError(422, f"Only ₹{rupees(max(owed, 0))} was owed to {supplier} on {paid_on}. Check the payment date.")
        if save is None:
            return {"paymentId": new_id(), "data": data, "contentType": content_type}
        payment_id, blob, at = save["paymentId"], save["blob"], stamp()
        await db.run("""INSERT INTO credit_payment (id, office_id, supplier, paid_on, amount, note, blob_path, file_name, content_type, byte_size, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", payment_id, office_id, supplier, paid_on, amount, note, blob,
                     receipts.safe_receipt_name(receipt.get("fileName"), blob), content_type, len(data), person["id"], at)
        await log(db, person["id"], "payment.create", "payment", payment_id, office_id, f"Paid ₹{amount} to {supplier} on {paid_on}.")
        result = {"paymentId": payment_id, "supplier": supplier, "date": paid_on, "amount": amount, "due": rupees(due - cents(amount))}
        if key:
            await db.run("INSERT INTO idempotency (person_id, key, request_hash, body, created_at) VALUES (?, ?, ?, ?, ?)", person["id"], key, hashed, dumps(result), at)
    return {"result": result}


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
