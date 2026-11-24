"""Suppliers: one list shared by every office, stored on purchases by name.

A bill prints the seller in many spellings: "BLINK COMMERCE PRIVATE LIMITED",
"Blink Commerce Pvt. Ltd.". `supplier_key` folds case, punctuation and the
usual company suffixes so a later bill from the same seller picks the same
supplier instead of adding a second one.
"""
import re
from .compat import text
from .core import HttpError, live_person, log, new_id, scoped, stamp

_SUFFIXES = ((r"\bpvt\b", "private"), (r"\bltd\b", "limited"), (r"\bco\b", "company"), (r"\binc\b", "incorporated"), (r"\bcorp\b", "corporation"))


def clean_supplier(value):
    """A supplier name with spacing tidied, or None when blank.

    A name with no letter or digit ("-", ".") is blank too: it has no matching
    key, so it could never be found again to reuse or pay.
    """
    if value is None or isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    clean = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f]", " ", text(value))).strip()
    if not clean or not supplier_key(clean):
        return None
    if len(clean) > 120:
        raise HttpError(422, "A supplier name needs 1 to 120 characters.")
    return clean


def supplier_key(name):
    key = re.sub(r"&", " and ", str(name or "").casefold())
    key = re.sub(r"[^\w\s]", " ", key)
    for pattern, word in _SUFFIXES:
        key = re.sub(pattern, word, key)
    return re.sub(r"\s+", " ", key).strip()


async def find_supplier(db, name):
    """The listed supplier with the same name, ignoring case, punctuation and suffix spelling."""
    wanted = supplier_key(name)
    if not wanted:
        return None
    for row in await db.all("SELECT name FROM supplier"):
        if supplier_key(row["name"]) == wanted:
            return row["name"]
    return None


async def ensure_supplier(db, person, office_id, name):
    """The listed name for this supplier, adding it on first use. The caller opens the transaction."""
    clean = clean_supplier(name)
    if not clean:
        return None
    existing = await find_supplier(db, clean)
    if existing:
        return existing
    supplier_id = new_id()
    await db.run("INSERT INTO supplier (id, name, created_by, created_at) VALUES (?, ?, ?, ?)", supplier_id, clean, person["id"], stamp())
    await log(db, person["id"], "supplier.create", "supplier", supplier_id, office_id, f"Added the supplier {clean}.")
    return clean


@scoped
async def list_suppliers(db, person):
    await live_person(db, person)
    return sorted((r["name"] for r in await db.all("SELECT name FROM supplier")), key=str.casefold)
