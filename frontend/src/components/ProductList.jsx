import { useId, useState } from "react";
import { api } from "../api.js";
import { useMounted } from "../hooks.js";

// The Product tab on Record: this office's products and a box to add one by
// name. A product's name is what it is (Milk, Coffee); there are no categories.
export function ProductList({ officeId, officeName, products, onSaved, onToast }) {
  const id = useId();
  const mounted = useMounted();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add(event) {
    event.preventDefault();
    if (busy) return;
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) {
      setError("Enter a product name.");
      return;
    }
    if (products.some((product) => product.name.trim().toLowerCase() === clean.toLowerCase())) {
      setError(`${clean} is already on this office's pantry.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await api(`/api/offices/${officeId}/products`, { method: "POST", body: { name: clean } });
      if (mounted.current) setName("");
      onToast?.(`Added ${saved.name}.`);
      await onSaved?.();
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <form className="record-form" onSubmit={add} noValidate>
      <div className="fields">
        <div className="field wide">
          <span id={`${id}-name`}>Product name</span>
          <span className="inline-input">
            <input
              value={name}
              maxLength={120}
              autoComplete="off"
              placeholder="Such as Green tea"
              aria-labelledby={`${id}-name`}
              aria-invalid={Boolean(error)}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
            <button className="solid small" type="submit" disabled={busy}>{busy ? "Adding…" : "Add product"}</button>
          </span>
        </div>
        {error ? <p className="error field wide" role="alert">{error}</p> : null}
        <div className="field wide">
          <span id={`${id}-list`}>Products at {officeName || "this office"}</span>
          <ul className="tag-list" aria-labelledby={`${id}-list`}>
            {products.map((product) => <li key={product.productId} className="tag">{product.name}</li>)}
          </ul>
          <small className="field-hint">The name is what you pick on a receipt or bill. Each office has its own products.</small>
        </div>
      </div>
    </form>
  );
}
