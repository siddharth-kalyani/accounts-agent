import { useId, useRef, useState } from "react";
import { api, countNote, shelfEstimate, wholePacks } from "../api.js";
import { IconEdit } from "../icons.jsx";
import { Modal } from "./Modal.jsx";

// The edit button on a Stock row and its dialog. Today's stock comes first
// because it is what people change most, then the warning days, then the name.
export function ProductEditor({ product, onSaved, onToast }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="icon-button edit-button"
        type="button"
        aria-label={`Edit ${product.name}`}
        title={`Edit ${product.name}`}
        onClick={() => setOpen(true)}
      >
        <IconEdit />
      </button>
      {open ? <EditDialog product={product} onClose={() => setOpen(false)} onSaved={onSaved} onToast={onToast} /> : null}
    </>
  );
}

function EditDialog({ product, onClose, onSaved, onToast }) {
  const countRef = useRef(null);
  const ids = useId();
  // Prefilled with today's count, or the expected shelf. Saved as today's count only once changed.
  const [count, setCount] = useState(String(shelfEstimate(product)));
  const [counted, setCounted] = useState(false);
  const [warning, setWarning] = useState(String(product.warningEffectiveDays));
  const [name, setName] = useState(product.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const renamed = name.trim() !== product.name;
  const rewarned = String(warning).trim() !== String(product.warningEffectiveDays);
  const dirty = counted || renamed || rewarned;

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    if (!dirty) {
      onClose();
      return;
    }
    const packs = counted ? wholePacks(count) : null;
    if (counted && packs == null) {
      setError("On hand is a whole number of packs, zero or more.");
      countRef.current?.focus();
      return;
    }
    const days = Number(warning);
    if (!/^\d+$/.test(String(warning).trim()) || days < 1 || days > 366) {
      setError("Warn from 1 to 366 working days ahead.");
      return;
    }
    if (!name.trim()) {
      setError("Enter a product name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/api/products/${product.productId}`, {
        method: "PATCH",
        body: { name: name.trim(), warningEffectiveDays: days, ...(counted ? { onHand: packs } : {}) },
      });
      await onSaved();
      onToast?.(counted && !renamed && !rewarned ? `Today's stock saved for ${name.trim()}.` : `${name.trim()} saved.`);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${product.name}`} onClose={onClose} initialFocus={countRef} dirty={dirty} className="narrow">
      <form className="edit-form" onSubmit={save} noValidate>
        <div className="field-block">
          <label className="field">On hand today (packs)
            <input
              ref={countRef}
              inputMode="numeric"
              autoComplete="off"
              value={count}
              aria-describedby={`${ids}-count`}
              onFocus={(event) => event.target.select()}
              onChange={(event) => {
                setCount(event.target.value);
                setCounted(true);
              }}
            />
          </label>
          <p className="field-hint" id={`${ids}-count`}>
            {product.todayCount != null
              ? "Counted today. Change it if the shelf differs."
              : `${countNote(product)}. Count the shelf and enter what is there. It saves as today's count.`}
          </p>
        </div>
        <div className="field-block">
          <label className="field">Warn this many working days before it runs out
            <input
              inputMode="numeric"
              autoComplete="off"
              value={warning}
              aria-describedby={`${ids}-warn`}
              onChange={(event) => setWarning(event.target.value)}
            />
          </label>
          <p className="field-hint" id={`${ids}-warn`}>Shows Due once on hand is expected to reach zero within these days.</p>
        </div>
        <label className="field">Product name
          <input value={name} maxLength={120} autoComplete="off" onChange={(event) => setName(event.target.value)} />
        </label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          <button className="ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
