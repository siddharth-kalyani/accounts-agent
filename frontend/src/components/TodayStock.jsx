import { useRef, useState } from "react";
import { api, countNote, indiaDate, packs, shelfEstimate, wholePacks } from "../api.js";
import { Modal } from "./Modal.jsx";

// Today's stock: one hand count per product, entered in one go. A blank row is
// not counted, so an expected figure is never saved as if someone had counted it.
export function TodayStock({ officeId, officeName, today, products, onClose, onSaved, onToast }) {
  const first = useRef(null);
  const form = useRef(null);
  const [values, setValues] = useState({});
  const [invalid, setInvalid] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const shown = (product) => values[product.productId] ?? (product.todayCount != null ? String(product.todayCount) : "");
  // Only rows someone typed into, and only where the figure differs from today's count.
  const entries = products
    .filter((product) => values[product.productId] !== undefined && values[product.productId].trim() !== "")
    .filter((product) => product.todayCount == null || wholePacks(values[product.productId]) !== Number(product.todayCount));
  const dirty = entries.length > 0;

  function nextField(event) {
    if (event.key !== "Enter") return;
    const fields = [...(form.current?.querySelectorAll("input") || [])];
    const at = fields.indexOf(event.currentTarget);
    if (at >= 0 && at < fields.length - 1) {
      event.preventDefault();
      fields[at + 1].focus();
      fields[at + 1].select();
    }
  }

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    if (!entries.length) {
      setError("Enter the packs on the shelf for at least one product.");
      first.current?.focus();
      return;
    }
    const bad = new Set(entries.filter((product) => wholePacks(values[product.productId]) == null).map((product) => product.productId));
    setInvalid(bad);
    if (bad.size) {
      setError("Enter whole packs, zero or more.");
      form.current?.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/api/offices/${officeId}/counts/today`, {
        method: "PUT",
        body: { counts: entries.map((product) => ({ productId: product.productId, packs: wholePacks(values[product.productId]) })) },
      });
      await onSaved();
      onToast?.(`Today's stock saved for ${entries.length} ${entries.length === 1 ? "product" : "products"}.`);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const done = products.filter((product) => product.todayCount != null).length;

  return (
    <Modal
      title="Today's stock"
      lede={`${officeName} · ${indiaDate(today)}. Count each shelf and enter the packs. Leave a row blank to skip it.`}
      onClose={onClose}
      initialFocus={first}
      dirty={dirty}
      className="narrow"
    >
      <form className="count-form" ref={form} onSubmit={save} noValidate>
        <p className="count-progress" role="status">{done} of {products.length} counted today</p>
        <ul className="count-list">
          {products.map((product, index) => {
            const wrong = invalid.has(product.productId);
            const estimate = shelfEstimate(product);
            return (
              <li key={product.productId} className={product.todayCount != null ? "is-counted" : undefined}>
                <div className="count-name">
                  <label htmlFor={`count-${product.productId}`}>{product.name}</label>
                  <small id={`count-${product.productId}-note`}>{product.todayCount != null ? countNote(product) : `${countNote(product)} · ${estimate ? `about ${packs(estimate)} expected` : "expected to be empty"}`}</small>
                </div>
                <input
                  id={`count-${product.productId}`}
                  aria-describedby={`count-${product.productId}-note`}
                  ref={index === 0 ? first : undefined}
                  inputMode="numeric"
                  autoComplete="off"
                  enterKeyHint={index === products.length - 1 ? "done" : "next"}
                  placeholder={String(estimate)}
                  value={shown(product)}
                  aria-invalid={wrong || undefined}
                  onKeyDown={nextField}
                  onChange={(event) => {
                    const value = event.target.value;
                    setValues((current) => ({ ...current, [product.productId]: value }));
                    if (wrong) setInvalid((current) => { const next = new Set(current); next.delete(product.productId); return next; });
                  }}
                />
              </li>
            );
          })}
        </ul>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button className="solid" type="submit" disabled={busy}>
            {busy ? "Saving…" : entries.length ? `Save ${entries.length} ${entries.length === 1 ? "count" : "counts"}` : "Save counts"}
          </button>
          <button className="ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
