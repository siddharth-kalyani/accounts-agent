import { useEffect, useState } from "react";
import { api, indiaDate, rupee } from "../api.js";
import { useFocusTrap } from "../focus.js";
import { useMounted } from "../hooks.js";
import { IconClose } from "../icons.jsx";
import { DateField } from "./DateField.jsx";
import { EmptyState } from "./Illustration.jsx";
import { Skeleton } from "./Skeleton.jsx";

export function Purchases({ officeId, officeName, month, monthName, revision, canWrite, onChanged, onToast, onUndoable, onRecord }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  const trap = useFocusTrap(Boolean(preview), () => closePreview());

  async function reload() {
    const data = await api(`/api/offices/${officeId}/purchases?month=${encodeURIComponent(month)}`);
    if (mounted.current) setRows(data.purchases);
  }

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError("");
    api(`/api/offices/${officeId}/purchases?month=${encodeURIComponent(month)}`)
      .then((data) => { if (!cancelled) setRows(data.purchases); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [officeId, month, revision]);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview]);

  function closePreview() {
    setPreview((current) => {
      if (current?.url) URL.revokeObjectURL(current.url);
      return null;
    });
  }

  async function loadReceipt(row) {
    const blob = await api(`/api/purchases/${row.purchaseId}/receipt`);
    return { blob, url: URL.createObjectURL(blob), type: blob.type || "application/pdf", name: row.receiptName || "receipt" };
  }

  async function openPreview(row) {
    setBusy(true);
    setError("");
    try {
      const next = await loadReceipt(row);
      setPreview(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function download(row) {
    setBusy(true);
    setError("");
    try {
      const next = await loadReceipt(row);
      const link = document.createElement("a");
      link.href = next.url;
      link.download = next.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(next.url), 1000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function downloadPreview() {
    if (!preview) return;
    const link = document.createElement("a");
    link.href = preview.url;
    link.download = preview.name;
    link.click();
  }

  async function saveCorrection(event) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/purchases/${editing.purchaseId}`, {
        method: "PUT",
        body: { date: editing.date, packs: Number(editing.packs), pricePerPack: editing.price },
      });
      setEditing(null);
      onToast?.("Purchase corrected.");
      await onChanged?.();
      setRows(null);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function unhide(id) {
    if (!mounted.current) return;
    setHidden((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  // The row disappears at once. The delete is only sent when the Undo toast
  // closes, so Undo needs no restore on the server.
  function removePurchase(row) {
    setEditing(null);
    setHidden((current) => new Set(current).add(row.purchaseId));
    onUndoable({
      text: `Removed ${row.packs} ${row.packs === 1 ? "pack" : "packs"} of ${row.product} from ${indiaDate(row.date)}.`,
      commit: async ({ keepalive } = {}) => {
        await api(`/api/purchases/${row.purchaseId}/delete`, { method: "POST", body: {}, keepalive });
        if (keepalive) return;
        await onChanged?.();
        await reload();
      },
      revert: () => unhide(row.purchaseId),
    });
  }

  async function attach(row, file) {
    if (!file) return;
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
      setError("A receipt is a PDF, JPEG, or PNG.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("A receipt is at most 10 MB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const dataBase64 = await readBase64(file);
      await api(`/api/purchases/${row.purchaseId}/receipt`, {
        method: "PUT",
        body: { receipt: { fileName: file.name, contentType: file.type, dataBase64 } },
      });
      onToast?.("Receipt attached.");
      await onChanged?.();
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = (rows || []).filter((row) => !hidden.has(row.purchaseId));

  return (
    <section className="card purchases-card">
      <div className="card-head">
        <div>
          <h2>Purchases and receipts</h2>
          <p className="lede-small">{officeName} · {monthName}. Change the month at the top.</p>
        </div>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {!rows && !error ? <Skeleton label="Loading purchases." rows={3} /> : null}
      {rows && !shown.length ? (
        <EmptyState
          art="receipt"
          title={`No purchases in ${monthName}.`}
          actions={canWrite && onRecord ? <button className="solid small" type="button" onClick={() => onRecord("purchase")}>Record a purchase</button> : null}
        >
          Each purchase you record shows here with its receipt, ready for accounts.
        </EmptyState>
      ) : null}
      <div className="purchase-list">
        {shown.map((row) => (
          <article className="purchase-row" key={row.purchaseId}>
            <div>
              <strong>{row.product}</strong>
              <p className="muted">{indiaDate(row.date)} · {row.packs} packs at {rupee(row.pricePerPack)}</p>
              <small className="muted">Entered by {row.enteredBy}</small>
              {row.receiptName ? <small className="muted">{row.receiptName}</small> : null}
            </div>
            <strong>{rupee(row.amount)}</strong>
            <div className="row-actions">
              {row.receiptName ? (
                <>
                  <button className="ghost" type="button" disabled={busy} onClick={() => openPreview(row)}>Preview receipt</button>
                  <button className="ghost" type="button" disabled={busy} onClick={() => download(row)}>Download receipt</button>
                </>
              ) : <span className="muted">No receipt</span>}
              {canWrite && !row.receiptName ? (
                <label className="ghost file-button">Attach receipt
                  <input className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => attach(row, event.target.files?.[0])} />
                </label>
              ) : null}
              {canWrite ? <button className="ghost" type="button" onClick={() => setEditing(editing?.purchaseId === row.purchaseId ? null : { ...row, price: row.pricePerPack })}>Correct</button> : null}
              {canWrite ? <button className="texty" type="button" onClick={() => removePurchase(row)}>Remove</button> : null}
            </div>
            {editing?.purchaseId === row.purchaseId ? (
              <form className="fields purchase-edit" onSubmit={saveCorrection}>
                <label className="field">Date
                  <DateField value={editing.date} onChange={(date) => setEditing({ ...editing, date })} required />
                </label>
                <label className="field">Packs
                  <input inputMode="numeric" value={editing.packs} onChange={(event) => setEditing({ ...editing, packs: event.target.value })} required />
                </label>
                <label className="field">Price per pack (INR)
                  <input inputMode="decimal" value={editing.price} onChange={(event) => setEditing({ ...editing, price: event.target.value })} required />
                </label>
                <div className="field wide row-actions">
                  <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : "Save correction"}</button>
                  <button className="ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </form>
            ) : null}
          </article>
        ))}
      </div>
      {preview ? (
        <div className="modal-back" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={preview.name} ref={trap} tabIndex={-1}>
            <div className="card-head">
              <h2>{preview.name}</h2>
              <div className="row-actions">
                <button className="ghost" type="button" onClick={downloadPreview}>Download receipt</button>
                <button className="icon-button" type="button" aria-label="Close" title="Close" onClick={closePreview}><IconClose /></button>
              </div>
            </div>
            {preview.type.startsWith("image/") ? <img className="receipt-preview" src={preview.url} alt={preview.name} /> : <iframe className="receipt-frame" title={preview.name} src={preview.url} />}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
