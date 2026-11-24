import { useEffect, useId, useRef, useState } from "react";
import { IconClose } from "../icons.jsx";
import { useSuppliers } from "../suppliers.js";
import { PickMenu } from "./PickMenu.jsx";

export const PACK_UNITS = ["N.A", "ml", "L", "g", "kg", "pcs"];

function wholeCount(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

function amount(value) {
  const text = String(value ?? "").trim().replace(/,/g, "");
  return /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function twoPlaces(value) {
  return String(Math.round(value * 100) / 100);
}

function totalOf(packs, price) {
  const count = wholeCount(packs);
  const each = amount(price);
  return count && each != null ? (count * each).toFixed(2) : "";
}

function wholeRatio(total, each) {
  if (!each) return null;
  const ratio = total / each;
  const rounded = Math.round(ratio);
  return rounded >= 1 && Math.abs(ratio - rounded) < 0.005 ? String(rounded) : null;
}

// Number of packs, price per pack and the total, kept in step:
// packs or price changes the total; a total changes the price per pack.
// With no packs yet, a total and a price per pack give the packs.
// `onChange` gets only the fields that changed ({ packs } and/or { price }).
// `bare` leaves out the wrapping grid, so the three boxes can share a row with others.
export function PackPriceFields({ packs, price, initialTotal = "", onChange, label = "", bare = false }) {
  const id = useId();
  const [total, setTotal] = useState(() => totalOf(packs, price) || String(initialTotal || ""));
  const fromTotal = useRef(false);

  useEffect(() => {
    if (fromTotal.current) {
      fromTotal.current = false;
      return;
    }
    const next = totalOf(packs, price);
    if (next) setTotal(next);
  }, [packs, price]);

  function editPacks(value) {
    const count = wholeCount(value);
    const sum = amount(total);
    if (count && amount(price) == null && sum != null) {
      fromTotal.current = true;
      onChange({ packs: value, price: twoPlaces(sum / count) });
      return;
    }
    onChange({ packs: value });
  }

  function editPrice(value) {
    const each = amount(value);
    const sum = amount(total);
    const count = !wholeCount(packs) && each && sum != null ? wholeRatio(sum, each) : null;
    if (count) {
      fromTotal.current = true;
      onChange({ price: value, packs: count });
      return;
    }
    onChange({ price: value });
  }

  function editTotal(value) {
    setTotal(value);
    const sum = amount(value);
    if (sum == null) return;
    const count = wholeCount(packs);
    if (count) {
      const each = twoPlaces(sum / count);
      if (each !== String(price)) {
        fromTotal.current = true;
        onChange({ price: each });
      }
      return;
    }
    const derived = wholeRatio(sum, amount(price));
    if (derived) {
      fromTotal.current = true;
      onChange({ packs: derived });
    }
  }

  const suffix = label ? ` for ${label}` : "";
  const boxes = (
    <>
      <label className="field" htmlFor={`${id}-price`}>Price per pack (INR)
        <input id={`${id}-price`} inputMode="decimal" autoComplete="off" value={price} aria-label={`Price per pack (INR)${suffix}`} onChange={(event) => editPrice(event.target.value)} />
      </label>
      <label className="field" htmlFor={`${id}-packs`}>Number of packs
        <input id={`${id}-packs`} inputMode="numeric" autoComplete="off" value={packs} aria-label={`Number of packs${suffix}`} onChange={(event) => editPacks(event.target.value)} />
      </label>
      <label className="field" htmlFor={`${id}-total`}>Total price (INR)
        <input id={`${id}-total`} inputMode="decimal" autoComplete="off" value={total} aria-label={`Total price (INR)${suffix}`} onChange={(event) => editTotal(event.target.value)} />
      </label>
    </>
  );
  return bare ? boxes : <div className="fields pack-price">{boxes}</div>;
}

// Size of one pack (500 ml) and its unit. N.A is for packs with no size, such as stick packets.
// `compact` puts the size and its unit side by side in one Pack size box.
export function PackSizeFields({ size, unit, onChange, label = "", compact = false }) {
  const id = useId();
  const chosen = unit || "N.A";
  const suffix = label ? ` for ${label}` : "";
  if (compact) {
    return (
      <div className="field">
        <span id={`${id}-label`}>Pack size</span>
        <div className="pack-inline" role="group" aria-labelledby={`${id}-label`}>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={chosen === "N.A" ? "" : size || ""}
            placeholder={chosen === "N.A" ? "N.A" : "500"}
            disabled={chosen === "N.A"}
            aria-label={`Qty per pack${suffix}`}
            onChange={(event) => onChange({ packSize: event.target.value, packUnit: chosen })}
          />
          <select value={chosen} aria-label={`Unit${suffix}`} onChange={(event) => onChange({ packUnit: event.target.value, packSize: event.target.value === "N.A" ? "" : size || "" })}>
            {PACK_UNITS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      </div>
    );
  }
  return (
    <div className="fields pack-size">
      <label className="field" htmlFor={`${id}-size`}>Qty per pack
        <input
          id={`${id}-size`}
          inputMode="decimal"
          autoComplete="off"
          value={chosen === "N.A" ? "" : size || ""}
          placeholder={chosen === "N.A" ? "N.A" : "500"}
          disabled={chosen === "N.A"}
          aria-label={`Qty per pack${suffix}`}
          onChange={(event) => onChange({ packSize: event.target.value, packUnit: chosen })}
        />
      </label>
      <label className="field" htmlFor={`${id}-unit`}>Unit
        <select id={`${id}-unit`} value={chosen} aria-label={`Unit${suffix}`} onChange={(event) => onChange({ packUnit: event.target.value, packSize: event.target.value === "N.A" ? "" : size || "" })}>
          {PACK_UNITS.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
    </div>
  );
}

const OTHER = "\u0000other";

// Supplier picker: suppliers already used on any bill, plus "Other supplier"
// to type a new name. A new name is added when the purchase is saved.
export function SupplierMenu({ value, onChange, label = "Supplier" }) {
  const suppliers = useSuppliers();
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState("");
  const listed = suppliers.some((item) => item.toLowerCase() === String(value || "").toLowerCase());
  const options = [
    { value: "", label: "No supplier" },
    ...(value && !listed ? [{ value, label: value, detail: "New supplier" }] : []),
    ...suppliers.map((item) => ({ value: item, label: item })),
    { value: OTHER, label: "+ Other supplier", detail: "Type the name" },
  ];

  function use() {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) return;
    onChange(clean);
    setTyping(false);
    setName("");
  }

  if (typing) {
    return (
      <div className="inline-input" data-escape-local>
        <input
          value={name}
          maxLength={120}
          autoFocus
          autoComplete="off"
          placeholder="Supplier name"
          aria-label="Supplier name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              use();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setTyping(false);
            }
          }}
        />
        <button className="solid small" type="button" onClick={use} disabled={!name.trim()}>Use</button>
        <button className="icon-button" type="button" aria-label="Cancel other supplier" title="Cancel" onClick={() => setTyping(false)}>
          <IconClose />
        </button>
      </div>
    );
  }

  return (
    <PickMenu
      options={options}
      value={value || ""}
      onChange={(next) => {
        if (next === OTHER) {
          setName("");
          setTyping(true);
          return;
        }
        onChange(next);
      }}
      label={label}
      placeholder="No supplier"
      searchLabel="Search suppliers"
      emptyText="No supplier matches that search."
    />
  );
}

export function CreditToggle({ checked, onChange, hint }) {
  const id = useId();
  return (
    <div className="credit-toggle">
      <label className="switch" htmlFor={id}>
        <input id={id} type="checkbox" role="switch" checked={Boolean(checked)} aria-describedby={`${id}-hint`} onChange={(event) => onChange(event.target.checked)} />
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        <span>Bought on credit</span>
      </label>
      <small className="field-hint" id={`${id}-hint`}>{hint || (checked ? "Added to what is due to this supplier on Payables." : "Paid at purchase. Nothing is due later.")}</small>
    </div>
  );
}

// "12 × 500 ml (6 L)" for a purchase with a pack size.
export function packSummary(packCount, size, unit) {
  if (!unit || unit === "N.A" || !size) return "";
  const count = Number(packCount);
  const each = Number(size);
  if (!count || !each) return `${size} ${unit} each`;
  const whole = count * each;
  const bigger = { ml: "L", g: "kg" }[unit];
  const shown = bigger && whole >= 1000 ? `${trim(whole / 1000)} ${bigger}` : `${trim(whole)} ${unit}`;
  return `${count} × ${size} ${unit} (${shown})`;
}

function trim(value) {
  return String(Math.round(value * 1000) / 1000);
}
