import { useEffect, useState } from "react";
import { api, daysUntil, indiaDate } from "../api.js";

const WEEKENDS = [
  ["0", "Closed", "No use on Saturday and Sunday"],
  ["0.2", "Light", "About a fifth of a weekday"],
  ["0.5", "Half", "About half a weekday"],
  ["1", "Full day", "Same as a weekday"],
];

function valid(weight, lookback) {
  const w = Number(weight);
  const l = Number(lookback);
  return weight !== "" && lookback !== "" && Number.isFinite(w) && w >= 0 && w <= 1 && Number.isInteger(l) && l >= 2 && l <= 36;
}

export function SettingsPanel({ settings, officeId, officeName, onSaved, onToast, embedded = false }) {
  const [weight, setWeight] = useState(String(settings?.weekendWeight ?? 0.2));
  const [lookback, setLookback] = useState(String(settings?.lookbackMonths ?? 3));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    if (!settings) return;
    setWeight(String(settings.weekendWeight));
    setLookback(String(settings.lookbackMonths));
  }, [settings]);

  const changed = settings && (Number(weight) !== Number(settings.weekendWeight) || Number(lookback) !== Number(settings.lookbackMonths));

  // Ask the server what would change. Nothing is saved until Save.
  useEffect(() => {
    setPreviewError("");
    if (!officeId || !changed || !valid(weight, lookback)) {
      setPreview(null);
      return undefined;
    }
    let cancel = false;
    const timer = setTimeout(() => {
      api(`/api/offices/${officeId}/settings-preview`, {
        method: "POST",
        body: { weekendWeight: Number(weight), lookbackMonths: Number(lookback) },
      })
        .then((data) => { if (!cancel) setPreview(data); })
        .catch((err) => { if (!cancel) { setPreview(null); setPreviewError(err.message); } });
    }, 350);
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [officeId, weight, lookback, changed]);

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api("/api/settings", {
        method: "PATCH",
        body: { weekendWeight: Number(weight), lookbackMonths: Number(lookback) },
      });
      setWeight(String(saved.weekendWeight));
      setLookback(String(saved.lookbackMonths));
      setPreview(null);
      await onSaved?.();
      onToast?.("Settings saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const preset = WEEKENDS.find(([value]) => Number(value) === Number(weight));
  const moved = (preview?.products || []).filter((row) => row.before !== row.after);

  const body = (
    <>
      {embedded ? null : <h2>Settings</h2>}
      {embedded ? null : <p className="lede">These apply to every office. They change how fast stock is expected to run out.</p>}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <form className="settings-form" onSubmit={save}>
        <fieldset className="setting">
          <legend>Weekends are</legend>
          <div className="choices setting-choices" role="group" aria-label="Weekend use">
            {WEEKENDS.map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                className="choice"
                aria-pressed={Number(value) === Number(weight)}
                title={hint}
                onClick={() => setWeight(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="note">{preset ? preset[2] : "A custom share of a weekday"}. Offices that shut at weekends should use Closed.</p>
          <label className="field">Weekend weight
            <input inputMode="decimal" min="0" max="1" step="0.01" value={weight} onChange={(event) => setWeight(event.target.value)} required />
          </label>
        </fieldset>
        <fieldset className="setting">
          <legend>History used</legend>
          <label className="field">Lookback months
            <input inputMode="numeric" min="2" max="36" value={lookback} onChange={(event) => setLookback(event.target.value)} required />
          </label>
          <p className="note">How many past months of purchases set the rate of use. A whole number from 2 to 36. Fewer months react faster to change.</p>
        </fieldset>

        {changed ? (
          <div className="settings-preview" role="status" aria-live="polite">
            <p className="panel-label">Preview{preview?.officeName || officeName ? ` for ${preview?.officeName || officeName}` : ""}</p>
            {!valid(weight, lookback) ? <p className="note">Enter a weekend weight from 0 to 1 and a whole number of months from 2 to 36.</p> : null}
            {previewError ? <p className="note">{previewError}</p> : null}
            {valid(weight, lookback) && !preview && !previewError ? <p className="note">Working out the new dates…</p> : null}
            {preview ? (
              moved.length ? (
                <ul className="preview-list">
                  {moved.map((row) => (
                    <li key={row.productId}>
                      <strong>{row.name}</strong>
                      <span>{previewLine(row)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="note">No run-out date changes at this office.</p>
            ) : null}
          </div>
        ) : null}

        <div className="field wide">
          <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </>
  );
  if (embedded) return <div className="receipt-review">{body}</div>;
  return <section className="card record-card">{body}</section>;
}

function previewLine(row) {
  if (!row.before) return `Would run out ${indiaDate(row.after)}`;
  if (!row.after) return `No date yet (was ${indiaDate(row.before)})`;
  const shift = daysUntil(row.before, row.after);
  const direction = shift > 0 ? `${shift} ${shift === 1 ? "day" : "days"} later` : `${-shift} ${shift === -1 ? "day" : "days"} sooner`;
  return `${indiaDate(row.before)} → ${indiaDate(row.after)}, ${direction}`;
}
