import { useId } from "react";
import { ProductMenu } from "./ProductMenu.jsx";
import { PackPriceFields, PackSizeFields } from "./PurchaseFields.jsx";

// The boxes of one product line, the same on a receipt line and a Purchase card:
// product, then pack size, price per pack, number of packs and total on one row,
// then MRP and today's count.
// `onHand` is { value, disabled, hint, onChange } where the count box goes, or
// { elsewhere } with the note to show when the count is on another line.
export function ProductLineFields({
  officeId,
  products,
  product,
  onProduct,
  onProductAdded,
  withOther = false,
  productLabel,
  label,
  packSize,
  packUnit,
  onPackSize,
  packs,
  price,
  initialTotal,
  onPackPrice,
  mrp,
  onMrp,
  note = null,
  onHand = null,
}) {
  const hintId = useId();
  const box = onHand && !onHand.elsewhere;
  return (
    <>
      <div className="fields">
        <div className="field wide">
          <span>Product</span>
          <ProductMenu
            officeId={officeId}
            products={products}
            value={product}
            label={productLabel}
            withOther={withOther}
            onChange={onProduct}
            onAdded={onProductAdded}
          />
        </div>
      </div>
      <div className="fields line-figures">
        <PackSizeFields compact size={packSize} unit={packUnit} label={label} onChange={onPackSize} />
        <PackPriceFields bare packs={packs ?? ""} price={price ?? ""} initialTotal={initialTotal} label={label} onChange={onPackPrice} />
      </div>
      {note}
      <div className="fields line-extras">
        <label className="field">MRP (INR)
          <input inputMode="decimal" autoComplete="off" value={mrp ?? ""} onChange={(event) => onMrp(event.target.value)} />
        </label>
        {box ? (
          <label className="field">On hand now (packs)
            <input
              inputMode="numeric"
              autoComplete="off"
              value={onHand.value}
              disabled={onHand.disabled}
              aria-describedby={hintId}
              onChange={(event) => onHand.onChange(event.target.value)}
            />
          </label>
        ) : null}
      </div>
      {box ? <p className="field-hint on-hand-hint" id={hintId}>{onHand.hint}</p> : null}
      {onHand?.elsewhere ? <p className="note">{onHand.elsewhere}</p> : null}
    </>
  );
}
