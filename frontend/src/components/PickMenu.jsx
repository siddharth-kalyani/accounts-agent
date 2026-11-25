import { useEffect, useRef, useState } from "react";
import { useMounted } from "../hooks.js";
import { IconChevron, IconClose } from "../icons.jsx";

// One searchable dropdown for the app. `options` are { value, label, detail?, icon?, sticky? }.
// A sticky option (such as "+ Add product") stays at the end whatever is searched.
// `onChange` gets the chosen value and the search text typed so far.
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
  const choices = options.filter((option) => !option.sticky && (!needle || `${option.label} ${option.detail || ""}`.toLowerCase().includes(needle)));
  const sticky = options.filter((option) => option.sticky);

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

  const item = (option) => (
    <button
      key={option.value}
      type="button"
      role="option"
      aria-selected={option.value === value}
      onClick={() => {
        onChange(option.value, query);
        setOpen(false);
      }}
    >
      <span className="pick-label">{option.icon || null}{option.label}</span>
      {option.detail ? <small>{option.detail}</small> : null}
    </button>
  );

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
        <span className={selected ? "pick-label" : "pick-placeholder"}>{selected?.icon || null}{selected?.label || placeholder}</span>
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
          {choices.map(item)}
          {!choices.length ? <p>{emptyText}</p> : null}
          {sticky.map(item)}
        </div>
      ) : null}
    </div>
  );
}

const ADD = "\u0000add";

// A PickMenu that ends in "+ Add …". Choosing it opens a name box (prefilled with
// what was searched) with Use; `onAdd(name)` saves the name and chooses it, and the
// box closes only once that worked. Without `onAdd` it is a plain PickMenu.
export function PickOrAdd({ options, onChange, onAdd, addLabel, nameLabel, cancelLabel, ...menu }) {
  const mounted = useMounted();
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function cancel() {
    setTyping(false);
    setName("");
    setError("");
  }

  async function use() {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean || busy) return;
    setBusy(true);
    setError("");
    try {
      await onAdd(clean);
      if (mounted.current) cancel();
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (typing) {
    return (
      <div className="inline-add" data-escape-local>
        <div className="inline-input">
          <input
            value={name}
            maxLength={120}
            autoFocus
            autoComplete="off"
            placeholder={nameLabel}
            aria-label={nameLabel}
            aria-invalid={Boolean(error)}
            readOnly={busy}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                use();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!busy) cancel();
              }
            }}
          />
          <button className="solid small" type="button" onClick={use} disabled={busy || !name.trim()}>{busy ? "Saving…" : "Use"}</button>
          <button className="icon-button" type="button" aria-label={cancelLabel} title="Cancel" onClick={cancel} disabled={busy}>
            <IconClose />
          </button>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <PickMenu
      {...menu}
      options={onAdd ? [...options, { value: ADD, label: `+ ${addLabel}`, detail: "Type the name", sticky: true }] : options}
      onChange={(next, query) => {
        if (next === ADD) {
          setName(String(query || "").trim());
          setError("");
          setTyping(true);
          return;
        }
        onChange(next);
      }}
    />
  );
}
