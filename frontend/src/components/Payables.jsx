import { useEffect, useRef, useState } from "react";
import { api, indiaDate, rupee } from "../api.js";
import { useFocusTrap } from "../focus.js";
import { useMounted } from "../hooks.js";
import { IconClose, IconDownload, IconEye, IconFile, IconTrash } from "../icons.jsx";
import { DateField } from "./DateField.jsx";
import { EmptyState } from "./Illustration.jsx";
import { Skeleton } from "./Skeleton.jsx";

// Payables: what this office owes each supplier for purchases bought on
// credit, month by month, and the payments that clear it. Every payment
// carries its proof of payment.
export function Payables({ officeId, officeName, month, monthName, revision, onChanged, onToast, onUndoable, onRecord }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(null);
  const [preview, setPreview] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  const trap = useFocusTrap(Boolean(preview), () => closePreview());

  async function reload() {
    const next = await api(`/api/offices/${officeId}/payables?month=${encodeURIComponent(month)}`);
    if (mounted.current) setData(next);
  }

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    api(`/api/offices/${officeId}/payables?month=${encodeURIComponent(month)}`)
      .then((next) => { if (!cancelled) setData(next); })
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

  async function loadProof(payment) {
    const blob = await api(`/api/payments/${payment.paymentId}/receipt`);
    return { url: URL.createObjectURL(blob), type: blob.type || "application/pdf", name: payment.receiptName || "payment receipt" };
  }

  async function openProof(payment) {
    setBusy(true);
    setError("");
    try {
      setPreview(await loadProof(payment));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function downloadProof(payment) {
    setBusy(true);
    setError("");
    try {
      const file = await loadProof(payment);
      saveFile(file);
      setTimeout(() => URL.revokeObjectURL(file.url), 1000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function startPayment(row) {
    setPaying({ supplier: row.supplier, due: row.due, date: data?.today || "", amount: row.due, note: "", receipt: null, error: "" });
  }

  // A retry of the same payment (say the reply was lost) reuses its key, so the
  // server returns the first payment instead of recording a second one.
  const paymentRequest = useRef(null);

  async function savePayment(event) {
    event.preventDefault();
    if (!paying || paying.busy) return;
    if (!paying.receipt) {
      setPaying({ ...paying, error: "Attach the payment receipt." });
      return;
    }
    setPaying({ ...paying, busy: true, error: "" });
    try {
      const body = { supplier: paying.supplier, date: paying.date, amount: String(paying.amount).trim().replace(/,/g, ""), note: paying.note.trim(), receipt: paying.receipt };
      const fingerprint = JSON.stringify({ officeId, body });
      if (paymentRequest.current?.fingerprint !== fingerprint) paymentRequest.current = { fingerprint, key: crypto.randomUUID() };
      const saved = await api(`/api/offices/${officeId}/payments`, {
        method: "POST",
        headers: { "Idempotency-Key": paymentRequest.current.key },
        body,
      });
      paymentRequest.current = null;
      if (!mounted.current) return;
      setPaying(null);
      onToast?.(`Paid ${rupee(saved.amount)} to ${saved.supplier}. ${Number(saved.due) > 0 ? `${rupee(saved.due)} still due.` : "Nothing left due."}`);
      await onChanged?.();
      await reload();
    } catch (err) {
      if (mounted.current) setPaying((current) => (current ? { ...current, busy: false, error: err.message } : current));
    }
  }

  function takeProof(file) {
    if (!paying) return;
    if (!file) {
      setPaying({ ...paying, receipt: null });
      return;
    }
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
      setPaying({ ...paying, error: "A receipt is a PDF, JPEG, or PNG." });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setPaying({ ...paying, error: "A receipt is at most 10 MB." });
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setPaying((current) => (current ? { ...current, error: "That file could not be read." } : current));
    reader.onload = () => setPaying((current) => (current ? { ...current, error: "", receipt: { fileName: file.name, contentType: file.type, dataBase64: String(reader.result).split(",")[1] } } : current));
    reader.readAsDataURL(file);
  }

  function unhide(id) {
    if (!mounted.current) return;
    setHidden((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  // The payment disappears at once; the removal is sent when the Undo toast closes.
  function removePayment(payment) {
    setHidden((current) => new Set(current).add(payment.paymentId));
    onUndoable({
      text: `Removed the ${rupee(payment.amount)} payment to ${payment.supplier}.`,
      commit: async ({ keepalive } = {}) => {
        await api(`/api/payments/${payment.paymentId}/delete`, { method: "POST", body: {}, keepalive });
        if (keepalive) return;
        await onChanged?.();
        await reload();
      },
      revert: () => unhide(payment.paymentId),
    });
  }

  const canWrite = Boolean(data?.canWrite);
  const payments = (data?.payments || []).filter((payment) => !hidden.has(payment.paymentId));
  const suppliers = data?.suppliers || [];

  return (
    <section className="card payables-card">
      <div className="card-head">
        <div>
          <h2>Payables</h2>
          <p className="lede-small">{officeName} · {monthName}. Bought on credit, paid, and still due. Change the month at the top.</p>
        </div>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {!data && !error ? <Skeleton label="Loading payables." rows={3} /> : null}
      {data ? (
        <>
          <div className="payables-totals">
            <p className="stat"><small className="muted">Due now</small><strong className={Number(data.due) > 0 ? "due-figure" : ""}>{rupee(data.due)}</strong></p>
            <p className="stat"><small className="muted">Bought on credit in {monthName}</small>{rupee(data.credit)}</p>
            <p className="stat"><small className="muted">Paid in {monthName}</small>{rupee(data.paid)}</p>
          </div>
          {!suppliers.length ? (
            <EmptyState
              art="receipt"
              title="Nothing bought on credit yet."
              actions={canWrite && onRecord ? <button className="solid small" type="button" onClick={() => onRecord("receipt")}>Read a receipt</button> : null}
            >
              Switch on Bought on credit when you record a bill. What is due to each supplier shows here until it is paid.
            </EmptyState>
          ) : (
            <div className="payables-list">
              {suppliers.map((row) => (
                <article className="payable-row" key={row.supplier}>
                  <div className="payable-name">
                    <strong>{row.supplier}</strong>
                    <small className="muted">Due now {rupee(row.due)}</small>
                  </div>
                  <dl className="payable-figures">
                    <div><dt>Opening</dt><dd>{rupee(row.opening)}</dd></div>
                    <div><dt>On credit</dt><dd>{rupee(row.credit)}</dd></div>
                    <div><dt>Paid</dt><dd>{rupee(row.paid)}</dd></div>
                    <div><dt>Closing</dt><dd>{rupee(row.closing)}</dd></div>
                  </dl>
                  <div className="row-actions">
                    {canWrite && Number(row.due) > 0 ? (
                      <button className="solid small" type="button" onClick={() => (paying?.supplier === row.supplier ? setPaying(null) : startPayment(row))} aria-expanded={paying?.supplier === row.supplier}>
                        Record payment
                      </button>
                    ) : Number(row.due) <= 0 ? <span className="pill on_track">Cleared</span> : null}
                  </div>
                  {paying?.supplier === row.supplier ? (
                    <form className="fields payment-form" onSubmit={savePayment} noValidate>
                      <label className="field">Paid on
                        <DateField max={data.today} value={paying.date} onChange={(date) => setPaying({ ...paying, date })} required />
                      </label>
                      <label className="field">Amount paid (INR)
                        <input inputMode="decimal" autoComplete="off" value={paying.amount} onChange={(event) => setPaying({ ...paying, amount: event.target.value, error: "" })} required />
                      </label>
                      <label className="field wide">Reference (optional)
                        <input maxLength={200} autoComplete="off" placeholder="UPI or bank reference" value={paying.note} onChange={(event) => setPaying({ ...paying, note: event.target.value })} />
                      </label>
                      <div className="field wide">
                        <span>Payment receipt <span className="required-mark" aria-hidden="true">*</span><span className="sr-only">, required</span></span>
                        <label className={`drop${paying.error && !paying.receipt ? " drop-missing" : ""}`}>
                          <input className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png" aria-required="true" onChange={(event) => takeProof(event.target.files?.[0])} />
                          <IconFile />
                          <span>{paying.receipt ? paying.receipt.fileName : "Drop or browse the payment proof"}</span>
                          <small>Required, so accounts can see what was paid. PDF, JPEG, or PNG up to 10 MB.</small>
                        </label>
                      </div>
                      {paying.error ? <p className="error field wide" role="alert">{paying.error}</p> : null}
                      <div className="field wide">
                        <div className="row-actions payment-actions">
                          <button className="solid" type="submit" disabled={paying.busy}>{paying.busy ? "Saving…" : "Save payment"}</button>
                          <button className="ghost" type="button" onClick={() => setPaying(null)} disabled={paying.busy}>Cancel</button>
                        </div>
                      </div>
                    </form>
                  ) : null}
                </article>
              ))}
            </div>
          )}

          <h3 className="payables-heading">Payments in {monthName}</h3>
          {payments.length ? (
            <div className="purchase-list">
              {payments.map((payment) => (
                <article className="purchase-row" key={payment.paymentId}>
                  <div>
                    <strong>{payment.supplier}</strong>
                    <p className="muted">{indiaDate(payment.date)}{payment.note ? ` · ${payment.note}` : ""}</p>
                    <small className="muted">Entered by {payment.enteredBy}</small>
                    <small className="muted">{payment.receiptName}</small>
                  </div>
                  <strong>{rupee(payment.amount)}</strong>
                  <div className="row-actions">
                    <button className="icon-button" type="button" disabled={busy} aria-label="Preview receipt" title="Preview receipt" onClick={() => openProof(payment)}><IconEye /></button>
                    <button className="icon-button" type="button" disabled={busy} aria-label="Download receipt" title="Download receipt" onClick={() => downloadProof(payment)}><IconDownload /></button>
                    {canWrite ? <button className="icon-button" type="button" aria-label="Remove payment" title="Remove payment" onClick={() => removePayment(payment)}><IconTrash /></button> : null}
                  </div>
                </article>
              ))}
            </div>
          ) : <p className="note">No payments in {monthName}.</p>}

          {data.purchases?.length ? (
            <>
              <h3 className="payables-heading">Bought on credit in {monthName}</h3>
              <div className="purchase-list">
                {data.purchases.map((row) => (
                  <article className="purchase-row" key={row.purchaseId}>
                    <div>
                      <strong>{row.product}</strong>
                      <p className="muted">{indiaDate(row.date)} · {row.supplier} · {row.packs} {row.packs === 1 ? "pack" : "packs"} at {rupee(row.pricePerPack)}</p>
                    </div>
                    <strong>{rupee(row.amount)}</strong>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}
      {preview ? (
        <div className="modal-back" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={preview.name} ref={trap} tabIndex={-1}>
            <div className="card-head">
              <h2>{preview.name}</h2>
              <div className="row-actions">
                <button className="icon-button" type="button" aria-label="Download receipt" title="Download receipt" onClick={() => saveFile(preview)}><IconDownload /></button>
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

function saveFile(file) {
  const link = document.createElement("a");
  link.href = file.url;
  link.download = file.name;
  link.click();
}
