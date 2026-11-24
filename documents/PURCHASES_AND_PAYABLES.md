# Purchases, suppliers and Payables

Phase 2 improvement requested in November 2026. Most pantry bills are bought on credit and cleared at month end; this records who is owed what and keeps proof of every payment.

## Data

- `pantry_purchase` gains `pack_size`, `pack_unit`, `supplier` and `on_credit`, all nullable, added by `migrate` in `core.py`. Older purchases keep NULL and read exactly as before: listed purchases show `packSize`, `packUnit`, `supplier` and `onCredit` only when set, so the Node contract fixtures stay byte for byte the same.
- **Pack size** is the size of one pack: 12 packs of 500 ml milk is `packs` 12, `pack_size` "500", `pack_unit` "ml". Units are `ml`, `L`, `g`, `kg`, `pcs` and `N.A` (`inventory.PACK_UNITS`); common spellings (ltr, gms, kgs, pieces, n/a) are folded in. `N.A` is for packs with no size, such as stick packets, and has no size. A size without a unit, or a unit without a size, is refused. Spend and stock math are unchanged: they still count packs.
- **Suppliers** are one list shared by every office (`supplier`, unique ignoring case), stored on purchases by name, like categories. `suppliers.supplier_key` folds case, punctuation, `&`, and Pvt/Ltd/Co/Inc spellings, so "Blink Commerce Pvt. Ltd." on a later bill reuses "BLINK COMMERCE PRIVATE LIMITED". A supplier is added the first time a saved purchase names it (`supplier.create` in Activity).
- **Credit** (`on_credit = 1`) needs a supplier. The amount owed is packs times price per pack. A credit purchase is stock, Activity and Purchases like any other, but it is **not spend until paid**: `get_pantry` leaves it out of each product's `spend` (shown as `creditSpend`) and adds the month's credit payments to the office `spend`. The office also gets `creditBought` and `creditPaid` when non-zero; without credit the response is unchanged.
- **Payments** are `credit_payment` rows (office, supplier, date, amount, optional reference note, proof file). The proof is required, checked like a receipt (PDF, JPEG or PNG from the bytes, at most 10 MB) and stored create-only as `payment-<id>-<random>.<ext>` in the same local folder or Cloud Storage bucket. A payment cannot be more than what is due to that supplier at that office. Removing a payment sets `deleted_at`; the balance goes back up. `migration.py` does not copy the new tables (the one-time SQLite to PostgreSQL cutover is already done); purchase columns travel with `pantry_purchase`.

## API

- `POST /api/offices/{id}/purchases/batch`: one bill with several products. Body `{date, supplier, onCredit, lines: [{productId, packs, pricePerPack, packSize, packUnit, mrp?, onHand?}], receipt}`. All purchases and any typed shelf counts save in one transaction; one product cannot carry two on-hand counts. Honors `Idempotency-Key` (a changed body with the same key is 409). The receipt is then stored for each purchase; a failed upload keeps the purchases and returns `receiptError`.
- `GET /api/suppliers`: the shared list, for anyone signed in.
- `GET /api/offices/{id}/payables?month=YYYY-MM`: for anyone who can view the office. Per supplier: `opening` (owed before the month), `credit` (bought on credit in the month), `paid` (paid in the month), `closing`, and `due` (owed today, all months). Also the month's `payments` and credit `purchases`, and office totals `due`, `credit`, `paid`.
- `POST /api/offices/{id}/payments`: `{supplier, date, amount, note?, receipt}`, for anyone who can write the office (Super Admin or its Office Manager). Accounts and Admin can view Payables and download proofs but cannot record payments, matching the role table.
- `GET /api/payments/{id}/receipt` (download, view access) and `POST /api/payments/{id}/delete` (soft delete, write access). Logged as `payment.create` and `payment.delete`.
- The single-purchase route `POST /api/offices/{id}/purchases` is unchanged and still used by the assistant.

## Receipt reading

The tool also asks for the seller (`supplier`), and per line `packSize`/`packUnit` from the description. The prompt lists only the office products and tells the model to use `lookup_item` (web search, now up to four times) to learn what an unknown brand is, so Amul Taaza is matched to Milk. Items that fit no office product (wall hooks, towels, hand wash, stationery, hardware) go under the Other product, added on approval when the office has none. A line without a printed size is `N.A`. The seller is matched to the supplier list with `supplier_key`; a new seller is proposed as printed and added on approval. A bill with a seller starts on credit; one without starts off credit, because credit needs a supplier. Older drafts read as off credit with `N.A` sizes.

## Screens

- **Record → Receipt:** Date, Supplier (pick or "+ Other supplier") and the Bought on credit switch apply to the whole receipt. Each line picks a product from the office's flat product list (no category grouping, no category picker); an unmatched line shows Other. Each line has Qty per pack and Unit, then Price per pack, Number of packs and Total price. GST and discount are gone; MRP stays.
- **Record → Purchase:** one bill: receipt (required), date, supplier, credit switch, then one card per product with the same fields as a receipt line, an on-hand box on the first card of each product, and "Add product" for another card. The bill total shows below the cards. After saving, the date, supplier and credit choice stay for the next bill.
- **Price, packs and total** stay in step (`PackPriceFields`): changing packs or price recalculates the total; typing a total sets the price per pack (rounded to paise); with no packs yet, a total and a price give the packs when they divide evenly. The total is never stored.
- **Payables** (Pantry nav, after Purchases, follows the month at the top): due now, bought on credit and paid this month; one row per supplier with opening, on credit, paid and closing; "Record payment" with date, amount (prefilled with what is due), reference and the required payment receipt; the month's payments with preview, download and remove (Undo toast, as for purchases); and the month's credit purchases.
- **Stock:** the summary shows Credit due next to Spent this month, linking to Payables. Under Spent it says how much was paid to suppliers and how much bought on credit is not yet spent; a product card shows its amount on credit.
- **Icons:** Discard, New product, Correct, Preview receipt, Download receipt and Remove are icon buttons with the old words as `aria-label` and tooltip.

## Tests

`backend/tests/test_payables.py` covers pack size parsing, supplier matching, the batch route (roles, credit without a supplier, half a pack size, two counts, idempotency, listing), older purchases reading as before, month-by-month payables, payment proof and over-payment refusals, download access, soft delete, receipt reading of supplier, product and pack size, and adding the columns to an existing database. `frontend/tests/e2e.mjs` drives a two-product bill on credit, the price/total link, a payment with proof, and credit due on Stock.
