import { useState } from "react";
import { addCategory, useCategories } from "../categories.js";
import { IconClose } from "../icons.jsx";
import { PickMenu } from "./PickMenu.jsx";

const NEW = "\u0000new";

// Searchable category picker with "+ New category". A new category is added
// for every office and chosen at once. Used inside forms, so Enter in the
// name box adds the category instead of submitting the form around it.
// `native` renders a plain select, for dialogs where a dropdown panel would be
// clipped; put it directly inside a `label.field` so it gets the shared look.
export function CategoryMenu({ value, onChange, officeId, label = "Category", canAdd = true, native = false }) {
  const categories = useCategories();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = [
    { value: "", label: "No category" },
    ...categories.map((category) => ({ value: category, label: category })),
    ...(canAdd && officeId ? [{ value: NEW, label: "+ New category" }] : []),
  ];

  async function save() {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) {
      setError("Enter a category name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await addCategory(officeId, clean);
      onChange(saved);
      setAdding(false);
      setName("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (adding) {
    return (
      <div className="category-new" data-escape-local>
        <div className="inline-input">
          <input
            value={name}
            maxLength={60}
            autoFocus
            autoComplete="off"
            placeholder="New category name"
            aria-label="New category name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              }
              if (event.key === "Escape") {
                // Close only this box, not a dialog around it.
                event.preventDefault();
                event.stopPropagation();
                setAdding(false);
              }
            }}
          />
          <button className="solid small" type="button" onClick={save} disabled={busy}>{busy ? "Adding…" : "Add"}</button>
          <button className="icon-button" type="button" aria-label="Cancel new category" onClick={() => { setAdding(false); setError(""); }}>
            <IconClose />
          </button>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
    );
  }

  function choose(next) {
    if (next === NEW) {
      setName("");
      setError("");
      setAdding(true);
      return;
    }
    onChange(next);
  }

  if (native) {
    return (
      <select value={value || ""} onChange={(event) => choose(event.target.value)}>
        {options.map((option) => <option key={option.value || "none"} value={option.value}>{option.label}</option>)}
      </select>
    );
  }

  return (
    <PickMenu
      options={options}
      value={value || ""}
      onChange={choose}
      label={label}
      placeholder="No category"
      searchLabel="Search categories"
      emptyText="No category matches that search."
    />
  );
}

// The Product tab on Record: every category, shared by all offices, and a box
// to add one. Products themselves are added from a bill (Purchase or Receipt).
export function CategoryList({ officeId, onToast }) {
  const categories = useCategories();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add(event) {
    event.preventDefault();
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) {
      setError("Enter a category name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const known = categories.some((item) => item.toLowerCase() === clean.toLowerCase());
      const saved = await addCategory(officeId, clean);
      setName("");
      onToast?.(known ? `${saved} is already a category.` : `Added the category ${saved}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="record-form" onSubmit={add}>
      <div className="fields">
        <label className="field wide">New category
          <span className="inline-input">
            <input value={name} maxLength={60} autoComplete="off" placeholder="Such as Fruit" onChange={(event) => { setName(event.target.value); setError(""); }} />
            <button className="solid small" type="submit" disabled={busy}>{busy ? "Adding…" : "Add"}</button>
          </span>
        </label>
        {error ? <p className="error field wide" role="alert">{error}</p> : null}
        <div className="field wide">
          <span>Categories</span>
          <ul className="category-list" aria-label="Categories">
            {categories.map((category) => <li key={category} className="category-tag">{category}</li>)}
          </ul>
          <small className="field-hint">Every office shares this list. New products are added from a bill on the Purchase or Receipt tab.</small>
        </div>
      </div>
    </form>
  );
}
