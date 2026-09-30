import { useEffect, useRef, useState } from "react";
import { IconChevron } from "../icons.jsx";

// One searchable dropdown for the app. `options` are { value, label, detail? }.
export function PickMenu({
  options,
  value,
  onChange,
  label,
  placeholder = "Choose",
  searchLabel = "Search",
  emptyText = "Nothing matches that search.",
  disabled = false,
}) {
  const root = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  const needle = query.trim().toLowerCase();
  const choices = options.filter((option) => !needle || `${option.label} ${option.detail || ""}`.toLowerCase().includes(needle));

  useEffect(() => {
    function close(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="product-pick" ref={root}>
      <button
        className="product-button"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
      >
        <span className={selected ? "" : "pick-placeholder"}>{selected?.label || placeholder}</span>
        <IconChevron />
      </button>
      {open ? (
        <div className="product-menu" role="listbox" aria-label={label}>
          <input
            className="product-search"
            type="text"
            value={query}
            placeholder={searchLabel}
            aria-label={searchLabel}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          {choices.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
              {option.detail ? <small>{option.detail}</small> : null}
            </button>
          ))}
          {!choices.length ? <p>{emptyText}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
