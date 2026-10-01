"""Daily shelf counts: the measured rate of use, today's stock, and warning-only Due."""
import pytest
from pantry import calc, inventory as i
from .test_accounts import fails

# Weekends closed keeps the arithmetic readable: 6 Sept 2026 is a Sunday.
CLOSED = {"weekendWeight": 0, "lookbackMonths": 3}
PRODUCT = {"reorderLevel": 0, "warningEffectiveDays": 5}


def count(day, packs, **extra):
    return {"countedOn": day, "packs": packs, **extra}


def buy(day, packs, price="10"):
    return {"purchasedOn": day, "packs": packs, "pricePerPack": price}


def math(purchases, counts, today="2026-09-20", settings=CLOSED, product=PRODUCT):
    return calc.compute_product(product=product, purchases=purchases, counts=counts, settings=settings, today=today)


def test_two_weeks_of_counts_give_a_rate_without_two_months_of_purchases():
    # One purchase in one month would never be enough history on its own.
    result = math([buy("2026-09-10", 10)], [count("2026-09-06", 30), count("2026-09-20", 20)])
    # Used 30 + 10 - 20 = 20 packs over the ten weekdays from 7 to 18 Sept.
    assert result["burnRatePerEffectiveDay"] == "2.00"
    assert result["trace"] == {"basis": "counts", "from": "2026-09-06", "to": "2026-09-20", "months": ["2026-09"], "packs": 20, "effectiveDays": "10"}
    assert (result["status"], result["onHand"], result["expectedDate"]) == ("on_track", "20.00", "2026-10-02")


def test_thirteen_days_of_counts_are_not_enough_yet():
    counts = [count("2026-09-07", 30), count("2026-09-20", 20)]
    result = math([buy("2026-09-10", 10)], counts)
    assert result["status"] == "not_enough_history" and result["burnRatePerEffectiveDay"] is None
    assert result["message"] == calc.NOT_ENOUGH and "two weeks of shelf counts" in result["message"]
    assert calc.counted_days(counts, CLOSED, "2026-09-20") == 13


def test_the_automatic_opening_count_is_not_a_shelf_count():
    # An office that already had stock still starts at an automatic zero. Using
    # it would read 0 + 20 - 8 = 12 packs used, a rate nobody measured.
    counts = [count("2026-09-01", 0, automatic=True), count("2026-09-20", 8)]
    result = math([buy("2026-09-02", 20)], counts)
    assert result["status"] == "not_enough_history" and result["trace"] is None
    assert calc.counted_days(counts, CLOSED, "2026-09-20") == 0


def test_counts_in_between_and_a_purchase_dated_a_day_late_do_not_skew_the_rate():
    ends = [count("2026-09-06", 30), count("2026-09-20", 20)]
    late = [buy("2026-09-14", 15)]
    # The shelf rose on the 13th because the purchase arrived before its receipt date.
    middle = [count("2026-09-13", 40), count("2026-09-16", 30)]
    assert math(late, ends)["burnRatePerEffectiveDay"] == math(late, ends + middle)["burnRatePerEffectiveDay"] == "2.50"


def test_stock_rising_more_than_purchases_asks_for_the_missing_purchase():
    result = math([], [count("2026-09-06", 10), count("2026-09-20", 25)])
    assert result["status"] == "not_enough_history" and result["message"] == calc.STOCK_ROSE


def test_purchases_after_the_latest_count_stay_out_of_the_measured_rate():
    counts = [count("2026-09-06", 30), count("2026-09-18", 10)]
    with_later = math([buy("2026-09-19", 50)], counts + [count("2026-08-30", 31)])
    assert with_later["trace"]["to"] == "2026-09-18" and with_later["trace"]["packs"] == 21
    # 10 counted on the 18th plus the 50 bought after it, less the weekend at zero use.
    assert with_later["onHand"] == "60.00"


def test_counts_draw_the_chart_line_when_purchases_fall_on_count_days():
    counts = [count(f"2026-09-{day:02d}", 40 - 2 * (day - 6)) for day in range(6, 21)]
    purchases = [buy("2026-09-06", 40)]
    result = math(purchases, counts, settings={"weekendWeight": 1, "lookbackMonths": 3})
    series = calc.stock_series(purchases=purchases, counts=counts, settings={"weekendWeight": 1, "lookbackMonths": 3}, today="2026-09-20", burnRate=result["burnRatePerEffectiveDay"], expectedDate=result["expectedDate"])
    history = [point for point in series if point["date"] < "2026-09-20"]
    assert history[0]["date"] == "2026-09-06" and history[0]["onHand"] == "40.00"
    assert [point["marker"] for point in history] == ["count"] * 14


def test_due_comes_from_the_warning_days_only():
    # Four packs left at two a weekday run out on Tuesday the 22nd: inside five working days.
    soon = math([buy("2026-09-10", 10)], [count("2026-09-06", 14), count("2026-09-20", 4)])
    assert soon["status"] == "due" and soon["expectedDate"] == "2026-09-22"
    later = math([buy("2026-09-10", 10)], [count("2026-09-06", 30), count("2026-09-20", 20)], product={"reorderLevel": 0, "warningEffectiveDays": 15})
    assert later["status"] == "due"


async def product_with_counts(db, manager, office, name="Count biscuits"):
    product = (await i.create_product(db, manager, office, name))["productId"]
    await i.create_purchase(db, manager, office, {"productId": product, "date": "2026-09-10", "packs": 10, "pricePerPack": "20"})
    await i.upsert_count(db, manager, office, {"productId": product, "date": "2026-09-06", "packs": 30})
    await i.upsert_count(db, manager, office, {"productId": product, "date": "2026-09-19", "packs": 22})
    return product


def row(pantry, product_id):
    return next(p for p in pantry["products"] if p["productId"] == product_id)


async def test_a_stored_reorder_level_no_longer_makes_a_product_due(db, people, offices):
    manager, office = people["manager"], offices["Ahmedabad"]
    product = await product_with_counts(db, manager, office)
    # Today's count makes two full weeks, so the product has a measured rate.
    await i.save_today_counts(db, manager, office, {"counts": [{"productId": product, "packs": 21}]})
    await i.update_product(db, manager, product, {"reorderLevel": 1000})
    shown = row(await i.get_pantry(db, manager, office, series=False), product)
    assert shown["reorderLevel"] == 0 and shown["status"] == "on_track"
    assert shown["trace"]["basis"] == "counts" and shown["expectedDate"] > "2026-09-30"


async def test_pantry_rows_say_what_was_counted(db, people, offices):
    manager, office = people["manager"], offices["Ahmedabad"]
    product = await product_with_counts(db, manager, office)
    shown = row(await i.get_pantry(db, manager, office, series=False), product)
    # The automatic opening count from creating the product is not a shelf count.
    assert (shown["todayCount"], shown["lastCountedOn"], shown["countedDays"]) == (None, "2026-09-19", 13)
    await i.save_today_counts(db, manager, office, {"counts": [{"productId": product, "packs": 21}]})
    shown = row(await i.get_pantry(db, manager, office, series=False), product)
    assert (shown["todayCount"], shown["lastCountedOn"], shown["countedDays"], shown["onHand"]) == (21, "2026-09-20", 14, "21.00")
    assert shown["trace"]["basis"] == "counts" and shown["burnRatePerEffectiveDay"]


async def test_todays_stock_is_saved_all_or_nothing_and_only_by_writers(db, people, offices):
    manager, office = people["manager"], offices["Ahmedabad"]
    products = [p["productId"] for p in (await i.get_pantry(db, manager, office, series=False))["products"][:2]]
    before = (await db.get("SELECT count(*) AS n FROM pantry_count"))["n"]
    with fails(422, "whole number"):
        await i.save_today_counts(db, manager, office, {"counts": [{"productId": products[0], "packs": 4}, {"productId": products[1], "packs": -1}]})
    with fails(422, "twice"):
        await i.save_today_counts(db, manager, office, {"counts": [{"productId": products[0], "packs": 4}, {"productId": products[0], "packs": 5}]})
    with fails(422, "at least one product"):
        await i.save_today_counts(db, manager, office, {"counts": []})
    pune = (await i.get_pantry(db, people["admin"], offices["Pune"], series=False))["products"][0]["productId"]
    with fails(422, "not available"):
        await i.save_today_counts(db, manager, office, {"counts": [{"productId": pune, "packs": 1}]})
    with fails(403):
        await i.save_today_counts(db, people["reader"], office, {"counts": [{"productId": products[0], "packs": 1}]})
    with fails(404):
        await i.save_today_counts(db, people["other"], office, {"counts": [{"productId": products[0], "packs": 1}]})
    assert (await db.get("SELECT count(*) AS n FROM pantry_count"))["n"] == before
    saved = await i.save_today_counts(db, manager, office, {"counts": [{"productId": products[0], "packs": 4}, {"productId": products[1], "packs": 0}]})
    assert saved == {"date": "2026-09-20", "saved": 2}
    rows = await db.all("SELECT packs FROM pantry_count WHERE counted_on = '2026-09-20' AND product_id IN (?, ?) ORDER BY packs", *products)
    assert [r["packs"] for r in rows] == [0, 4]
    after = (await db.get("SELECT count(*) AS n FROM pantry_count"))["n"]
    # Counting again the same day corrects the count; it does not add a second one.
    await i.save_today_counts(db, manager, office, {"counts": [{"productId": products[0], "packs": 6}]})
    assert (await db.get("SELECT count(*) AS n FROM pantry_count"))["n"] == after
    assert (await db.get("SELECT packs FROM pantry_count WHERE counted_on = '2026-09-20' AND product_id = ?", products[0]))["packs"] == 6


async def test_a_purchase_can_carry_todays_count_in_the_same_save(db, people, offices):
    manager, office = people["manager"], offices["Ahmedabad"]
    product = (await i.create_product(db, manager, office, "Counted with purchase"))["productId"]
    body = {"productId": product, "date": "2026-09-18", "packs": 12, "pricePerPack": "15", "onHand": 9}
    with fails(422, "zero or more"):
        await i.create_purchase(db, manager, office, {**body, "onHand": -2})
    assert not await db.get("SELECT id FROM pantry_purchase WHERE product_id = ?", product)
    first = await i.create_purchase(db, manager, office, body, None, "count-with-purchase-1")
    again = await i.create_purchase(db, manager, office, body, None, "count-with-purchase-1")
    assert first["purchaseId"] == again["purchaseId"]
    assert (await db.get("SELECT count(*) AS n FROM pantry_purchase WHERE product_id = ?", product))["n"] == 1
    counted = await db.all("SELECT counted_on, packs FROM pantry_count WHERE product_id = ? AND counted_on = '2026-09-20'", product)
    assert [dict(r) for r in counted] == [{"counted_on": "2026-09-20", "packs": 9}]
    assert row(await i.get_pantry(db, manager, office, series=False), product)["onHand"] == "9.00"
    with fails(409):
        await i.create_purchase(db, manager, office, {**body, "onHand": 10}, None, "count-with-purchase-1")
    # Without onHand a purchase writes no count, as before.
    await i.create_purchase(db, manager, office, {**body, "onHand": None, "date": "2026-09-20"})
    assert (await db.get("SELECT count(*) AS n FROM pantry_count WHERE product_id = ? AND counted_on = '2026-09-20'", product))["n"] == 1


async def test_editing_a_product_can_set_todays_count(db, people, offices):
    manager, office = people["manager"], offices["Ahmedabad"]
    product = (await i.create_product(db, manager, office, "Edited count"))["productId"]
    logged = lambda: db.all("SELECT action FROM operation WHERE entity_id = ? ORDER BY at", product)
    await i.update_product(db, manager, product, {"name": "Edited count", "warningEffectiveDays": 5, "onHand": 7})
    assert row(await i.get_pantry(db, manager, office, series=False), product)["todayCount"] == 7
    # Only the count changed, so the product itself is not logged as edited.
    assert [r["action"] for r in await logged()] == ["product.create"]
    await i.update_product(db, manager, product, {"name": "Edited count bars", "warningEffectiveDays": 6, "onHand": 8})
    shown = row(await i.get_pantry(db, manager, office, series=False), product)
    assert (shown["name"], shown["warningEffectiveDays"], shown["todayCount"]) == ("Edited count bars", 6, 8)
    with fails(422, "Warn from 1 to 366 working days ahead."):
        await i.update_product(db, manager, product, {"warningEffectiveDays": 0})
    with fails(422, "zero or more"):
        await i.update_product(db, manager, product, {"onHand": "lots"})
    with fails(403):
        await i.update_product(db, people["reader"], product, {"onHand": 1})


@pytest.mark.parametrize("weekend", [0, 0.2, 1])
def test_settings_lookback_bounds_the_counts_used(weekend):
    settings = {"weekendWeight": weekend, "lookbackMonths": 2}
    counts = [count("2026-07-01", 90), count("2026-08-03", 60), count("2026-09-20", 20)]
    # Two months back from September starts on 1 August, so the July count is left out.
    assert math([], counts, settings=settings)["trace"]["from"] == "2026-08-03"
