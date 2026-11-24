# Product categories and the Purchase tab

Phase 2 improvement requested in November 2026.

## Categories

- One list shared by every office: `product_category` (id, name, created_by, created_at), with names unique ignoring case. The first start of any database seeds `DEFAULT_CATEGORIES` in `core.py`: Beverages, Dairy, Groceries, Snacks, Cleaning & Hygiene, Disposables, Household, Other. Seeding runs only while the table is empty.
- A product stores its category **by name** in `pantry_product.category` (nullable). This keeps products self-contained when the one-time SQLite to PostgreSQL migration copies them, because `product_category` is not in its `TABLES`. A target database gets the default list from its own start.
- `GET /api/categories` lists them for any signed-in person, with Other last. `POST /api/offices/{id}/categories` adds one for anyone who can write that office (Super Admin or its Office Manager). Adding a name that already exists returns that category with `created: false`. Additions are logged as `category.create`.
- A product create or update names a category from the list, ignoring case. An unknown name is refused with "Choose a category from the list." An update that leaves out `category` keeps it, and `null` or `""` clears it. A category-only change is logged as `product.category`.
- `category` appears on pantry products and listed purchases only when it is set. Older responses, and the Node contract fixtures, stay byte for byte the same.
- There is no rename or delete for categories yet.

## Screens

- **Record → Purchase:** on each product card, the New product icon beside Product opens a small box (name only). Adding a product creates it, refreshes the pantry and selects it on that card without clearing the rest of the bill. The product list is flat, as on main: no grouping by category. Only MRP stays as an optional printed detail; GST % and discount are no longer entered (see [Purchases and payables](PURCHASES_AND_PAYABLES.md)).
- **Record → Product** has no name box: it lists every category and adds one ("New category", then Add). Products are added from the New product icon on a Purchase card; a receipt adds only Other. Stock's empty state links to the Purchase tab.
- Only the **Stock edit dialog** chooses a category. Receipt and Purchase do not: they pick from the flat product list, and receipt lines that fit no product go under Other. The dialog uses a plain select (`CategoryMenu native`), because a dropdown panel would be clipped by the dialog.
- **Stock** shows a category tag under each product name, and a category filter appears once any product has a category. Search also matches category names. **Purchases** shows the tag beside the product.
- "+ New category" sits inside every category picker. Its inline box handles Enter (add) and Escape (close) itself. `data-escape-local` tells the dialog focus trap (`focus.js`) not to close the dialog on that Escape.

## Tests

`backend/tests/test_categories.py` covers the default list and its order, who can add, case-insensitive reuse, product create/update/clear, unknown names, manual purchase details and save-key conflicts, receipt lines that fit no product going under Other, and adding the column and list to an existing database. `fixtures/http-routes.json` lists the two new routes.
