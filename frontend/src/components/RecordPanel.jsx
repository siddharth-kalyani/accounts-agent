import { useEffect, useId, useRef, useState } from "react";
import { api, indiaDate, onHandAfter, packs, rupee, wholePacks } from "../api.js";
import { useMounted } from "../hooks.js";
import { IconFile } from "../icons.jsx";
import { DateField } from "./DateField.jsx";
import { ProductMenu } from "./ProductMenu.jsx";
import { Skeleton } from "./Skeleton.jsx";

// `onHand` is today's shelf count typed with a purchase; it is only sent once
// someone changes it (`onHandTouched`), so an expected figure is never saved as a count.
const empty = { kind: "receipt", name: "", productId: "", date: "", packs: "", price: "", onHand: "", onHandTouched: false };
const KINDS = ["receipt", "purchase", "product"];
const ON_HAND_ERROR = "On hand is a whole number of packs, zero or more.";

export function RecordPanel({ pantry, officeId, officeName, onSubmit, onSaved, onToast, busy, loading, initialKind = "receipt" }) {
  const purchaseFileRef = useRef(null);
  const receiptFileRef = useRef(null);
  const readingRef = useRef(null);
  const patchChain = useRef(Promise.resolve());
  const patchTimer = useRef(null);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const mounted = useMounted();
  const [form, setForm] = useState({ ...empty, kind: KINDS.includes(initialKind) ? initialKind : empty.kind, date: pantry?.today || todayIso() });
  // What was just saved, so a run of purchases after one shopping trip is quick.
  const [lastSaved, setLastSaved] = useState(null);
  const prefilledPrice = useRef("");
  const [receipt, setReceipt] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fileError, setFileError] = useState("");
  const [heldPurchase, setHeldPurchase] = useState(null);
  const [upload, setUpload] = useState(null);
  const [uploadPreview, setUploadPreview] = useState("");
  const [readError, setReadError] = useState("");
  const [readBusy, setReadBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(null);
  // Receipt review: today's shelf count typed per product, keyed by product id.
  const [shelf, setShelf] = useState({});
  const [onHandError, setOnHandError] = useState("");
  const hintId = useId();
  const canWrite = Boolean(pantry?.canWrite);

  useEffect(() => {
    readingRef.current = reading;
  }, [reading]);


  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => () => {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
  }, [uploadPreview]);

  useEffect(() => {
    if (!officeId || !canWrite) return undefined;
    let cancel = false;
    api(`/api/offices/${officeId}/receipt-readings/open`)
      .then((data) => {
        if (!cancel && data.reading) setReading(data.reading);
      })
      .catch((err) => {
        if (!cancel) setReadError(err.message);
      });
    return () => {
      cancel = true;
    };
  }, [officeId, canWrite]);

  useEffect(() => {
    if (!officeId || reading?.status !== "reading") return undefined;
    let cancel = false;
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > 240000) {
        const message = "This is taking too long. Try the receipt again.";
        if (!cancel) {
          setReadError(message);
          setReading((current) => (current ? { ...current, status: "failed", error: message } : current));
        }
        return;
      }
      try {
        const data = await api(`/api/offices/${officeId}/receipt-readings/${reading.readingId}`);
        if (cancel) return;
        setReading(data);
        if (data.status === "failed") setReadError(data.error || "The receipt could not be read.");
        if (data.status === "ready") setReadError("");
      } catch (err) {
        if (!cancel) setReadError(err.message);
      }
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      cancel = true;
      clearInterval(timer);
    };
  }, [officeId, reading?.readingId, reading?.status]);

  useEffect(() => () => {
    clearTimeout(patchTimer.current);
    const pending = readingRef.current;
    if (!dirtyRef.current || !officeId || pending?.status !== "ready") return;
    dirtyRef.current = false;
    const body = patchBody(pending);
    patchChain.current = patchChain.current.catch(() => {}).then(() => api(`/api/offices/${officeId}/receipt-readings/${pending.readingId}`, {
      method: "PATCH",
      body,
    })).catch(() => {});
  }, [officeId]);

  function enqueuePatch(next, rev) {
    const body = patchBody(next);
    patchChain.current = patchChain.current.catch(() => {}).then(async () => {
      const saved = await api(`/api/offices/${officeId}/receipt-readings/${next.readingId}`, { method: "PATCH", body });
      if (rev === revision.current) {
        readingRef.current = saved;
        if (mounted.current) setReading(saved);
      }
      return saved;
    });
    return patchChain.current;
  }

  function remember(next, immediate) {
    revision.current += 1;
    const rev = revision.current;
    readingRef.current = next;
    setReading(next);
    if (next?.status !== "ready") return;
    dirtyRef.current = true;
    clearTimeout(patchTimer.current);
    const send = () => {
      if (rev !== revision.current) return;
      dirtyRef.current = false;
      enqueuePatch(next, rev).catch((err) => {
        if (rev === revision.current && mounted.current) setReadError(err.message);
      });
    };
    if (immediate) send();
    else patchTimer.current = setTimeout(send, 400);
  }

  function changeLine(id, patch, immediate) {
    const current = readingRef.current;
    if (!current?.result) return;
    remember({
      ...current,
      result: {
        ...current.result,
        lines: current.result.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
      },
    }, immediate);
  }

  function changeDate(date) {
    const current = readingRef.current;
    if (!current?.result) return;
    remember({ ...current, result: { ...current.result, date } }, false);
  }

  function choosePurchaseProduct(productId) {
    const product = (pantry?.products || []).find((item) => item.productId === productId);
    const last = product?.latestPricePerPack ? String(product.latestPricePerPack) : "";
    const untouched = !form.price || form.price === prefilledPrice.current;
    if (untouched) prefilledPrice.current = last;
    // A count typed for one product must not carry over to another.
    setForm({ ...form, productId, price: untouched ? last : form.price, onHand: "", onHandTouched: false });
    setOnHandError("");
  }

  async function submit(event) {
    event.preventDefault();
    // A purchase recorded here needs its receipt. (Receipts stay optional on
    // the server: the assistant and receipt reading create purchases too, and
    // an old purchase can still get a receipt from Purchases.)
    if (form.kind === "purchase" && !receipt) {
      setFileError("Attach the receipt for this purchase.");
      purchaseFileRef.current?.closest(".field")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const counted = form.kind === "purchase" && form.onHandTouched && String(form.onHand).trim() !== "";
    if (counted && wholePacks(form.onHand) == null) {
      setOnHandError(ON_HAND_ERROR);
      return;
    }
    setOnHandError("");
    if (heldPurchase && form.kind === "purchase" && samePurchase(form, heldPurchase) && receipt) {
      const ok = await onSubmit({ ...form, kind: "attach", purchaseId: heldPurchase.purchaseId }, receipt);
      if (ok === true) {
        clearPurchaseFile();
        setHeldPurchase(null);
        setForm({ ...empty, date: form.date || pantry?.today || todayIso(), kind: form.kind });
      }
      return;
    }
    if (heldPurchase && !samePurchase(form, heldPurchase)) setHeldPurchase(null);
    const sent = { ...form, onHand: counted ? wholePacks(form.onHand) : null };
    const result = await onSubmit(sent, form.kind === "purchase" ? receipt : null);
    if (result === true) {
      if (form.kind === "purchase") {
        const product = (pantry?.products || []).find((item) => item.productId === form.productId);
        setLastSaved({ name: product?.name || "the product", packs: form.packs, price: form.price, date: form.date, hadReceipt: Boolean(receipt), onHand: sent.onHand });
      }
      clearPurchaseFile();
      setHeldPurchase(null);
      prefilledPrice.current = "";
      // Keep the date: the next purchase is usually from the same trip.
      setForm({ ...empty, date: form.kind === "purchase" ? form.date : pantry?.today || todayIso(), kind: form.kind });
      setFileError("");
    } else if (result?.purchaseId) {
      setHeldPurchase({ purchaseId: result.purchaseId, productId: form.productId, date: form.date, packs: form.packs, price: form.price });
    }
  }

  function clearPurchaseFile() {
    setReceipt(null);
    setFileError("");
    if (purchaseFileRef.current) purchaseFileRef.current.value = "";
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
  }

  function clearUpload() {
    setUpload(null);
    if (receiptFileRef.current) receiptFileRef.current.value = "";
    setUploadPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
  }

  function takeFile(file, target) {
    const purchaseTarget = target === "purchase";
    const setError = purchaseTarget ? setFileError : setReadError;
    const setPayload = purchaseTarget ? setReceipt : setUpload;
    const setUrl = purchaseTarget ? setPreviewUrl : setUploadPreview;
    const ref = purchaseTarget ? purchaseFileRef : receiptFileRef;
    setError("");
    if (!file) {
      setPayload(null);
      if (ref.current) ref.current.value = "";
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });
      return;
    }
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
      setError("A receipt is a PDF, JPEG, or PNG.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("A receipt is at most 10 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read.");
    reader.onload = () => {
      setPayload({
        fileName: file.name,
        contentType: file.type,
        dataBase64: String(reader.result).split(",")[1],
      });
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
    };
    reader.readAsDataURL(file);
  }

  async function readReceipt() {
    if (!upload || readBusy) return;
    setReadBusy(true);
    setReadError("");
    try {
      const data = await api(`/api/offices/${officeId}/receipt-readings`, { method: "POST", body: { receipt: upload } });
      const next = { readingId: data.readingId, status: "reading", error: null, fileName: upload.fileName, result: null };
      readingRef.current = next;
      setReading(next);
    } catch (err) {
      setReadError(err.message);
    } finally {
      setReadBusy(false);
    }
  }

  async function clearReading() {
    const current = readingRef.current;
    if (!current || saving) return;
    setReadError("");
    try {
      await api(`/api/offices/${officeId}/receipt-readings/${current.readingId}/dismiss`, { method: "POST", body: {} });
      clearTimeout(patchTimer.current);
      dirtyRef.current = false;
      revision.current += 1;
      readingRef.current = null;
      setReading(null);
      setShelf({});
      clearUpload();
    } catch (err) {
      setReadError(err.message);
    }
  }

  async function addPurchases() {
    const current = readingRef.current;
    if (!current?.result || saving) return;
    clearTimeout(patchTimer.current);
    setSaving(true);
    setReadError("");
    try {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        await enqueuePatch(current, revision.current);
      } else {
        await patchChain.current;
      }
    } catch (err) {
      setReadError(err.message);
      setSaving(false);
      return;
    }
    const latest = readingRef.current;
    const lines = (latest?.result?.lines || []).filter((line) => !line.discarded);
    if (!lines.length) {
      setReadError("Choose at least one line to add.");
      setSaving(false);
      return;
    }
    if (lines.some((line) => !line.productId)) {
      setReadError("Choose a product for each remaining line, or discard it.");
      setSaving(false);
      return;
    }
    if (!latest.result.date || lines.some((line) => line.packs === "" || line.packs == null || line.pricePerPack === "" || line.pricePerPack == null)) {
      setReadError("Enter a date, packs, and a price for each remaining line, or discard it.");
      setSaving(false);
      return;
    }
    const kept = new Set(lines.map((line) => line.productId));
    const counts = Object.entries(shelf).filter(([productId, value]) => kept.has(productId) && String(value).trim() !== "");
    if (counts.some(([, value]) => wholePacks(value) == null)) {
      setReadError(ON_HAND_ERROR);
      setSaving(false);
      return;
    }
    try {
      const saved = await api(`/api/offices/${officeId}/receipt-readings/${latest.readingId}/save`, {
        method: "POST",
        body: {
          date: latest.result.date,
          lines: lines.map((line) => ({
            id: line.id,
            productId: line.productId,
            packs: line.packs,
            pricePerPack: line.pricePerPack,
          })),
          ...(counts.length ? { counts: counts.map(([productId, value]) => ({ productId, packs: wholePacks(value) })) } : {}),
        },
      });
      onToast?.(counts.length ? "Purchases and today's stock added." : "Purchases added.");
      const receiptError = saved.purchases?.find((purchase) => purchase.receiptError)?.receiptError;
      readingRef.current = null;
      setReading(null);
      setShelf({});
      clearUpload();
      if (receiptError) setReadError(receiptError);
      await onSaved?.();
    } catch (err) {
      setReadError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !pantry) {
    return (
      <section className="card record-card">
        <h2>Record</h2>
        <Skeleton label={`Loading ${officeName || "the office"}.`} rows={2} />
      </section>
    );
  }

  if (!canWrite) {
    return (
      <section className="card record-card">
        <h2>Record</h2>
        <p className="lede">This sign-in can view {officeName || "the office"}. It cannot change the pantry.</p>
      </section>
    );
  }

  const products = (pantry.products || []).filter((product) => !product.deletedAt);
  const kinds = [
    ["receipt", "Receipt"],
    ["purchase", "Purchase"],
    ["product", "Product"],
  ];
  const lede = form.kind === "receipt"
    ? "One receipt can add several purchases. Nothing is saved until you approve it."
    : form.kind === "product"
      ? `Adds a product at ${officeName || "this office"}.`
      : `${officeName}. Attach the receipt for each purchase.`;
  const visibleLines = (reading?.result?.lines || []).filter((line) => !line.discarded);
  const alert = readError || (reading?.status === "failed" ? reading.error : "");
  const showUpload = !reading || reading.status === "failed";
  // One on-hand box per product on a receipt, on its first line, counting every line of it.
  const firstLine = {};
  const addedBy = {};
  for (const line of visibleLines) {
    if (!line.productId) continue;
    firstLine[line.productId] ??= line.id;
    addedBy[line.productId] = (addedBy[line.productId] || 0) + (Number(line.packs) || 0);
  }
  const chosen = products.find((product) => product.productId === form.productId);
  const onHandValue = form.onHandTouched ? form.onHand : chosen ? String(onHandAfter(chosen, form.date, form.packs)) : "";

  return (
    <section className="card record-card">
      <div className="card-head">
        <div>
          <h2>Record</h2>
          <p className="lede-small">{lede}</p>
        </div>
      </div>
      <div className="choices" role="group" aria-label="What to record">
        {kinds.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className="choice"
            aria-pressed={form.kind === kind}
            onClick={() => setForm({ ...form, kind })}
          >
            {label}
          </button>
        ))}
      </div>
      {reading && form.kind !== "receipt" ? <p className="note">A receipt is waiting on the Receipt tab.</p> : null}

      {form.kind === "receipt" ? (
        <div className="receipt-review">
          {reading?.status === "reading" ? (
            <p className="receipt-wait" role="status" aria-live="polite">Reading the receipt…</p>
          ) : null}
          {reading?.status === "ready" && reading.result ? (
            <div className="fields">
              {reading.fileName ? <p className="note">{reading.fileName}</p> : null}
              {reading.result.note ? <p className="note">{reading.result.note}</p> : null}
              {reading.result.note ? <p className="note">Editing packs or price does not redo this check.</p> : null}
              <label className="field">Date
                <DateField max={pantry.today} value={reading.result.date || ""} onChange={changeDate} />
              </label>
              <div className="field wide receipt-lines">
                {visibleLines.length ? visibleLines.map((line) => (
                  <article key={line.id} className={`receipt-line${line.productId ? "" : " unmatched"}`}>
                    <div className="receipt-line-head">
                      <strong>{line.printed}</strong>
                      <button className="texty" type="button" onClick={() => changeLine(line.id, { discarded: true }, true)}>Discard</button>
                    </div>
                    {line.lineTotal ? <p className="note">Printed line amount: {rupee(line.lineTotal)}</p> : null}
                    {line.note ? <p className="note" role="status">{line.note}</p> : null}
                    {line.productId ? null : <p className="note">Not one of this office's products. Add it on the Product tab, then choose it here.</p>}
                    <div className="field">
                      <span>Product</span>
                      <ProductMenu
                        products={products}
                        value={line.productId}
                        label={`Product for ${line.printed}`}
                        onChange={(productId) => {
                          const product = products.find((item) => item.productId === productId);
                          changeLine(line.id, {
                            productId: productId || "",
                            productName: product?.name || "",
                            matched: Boolean(productId),
                          }, true);
                        }}
                      />
                    </div>
                    <div className="fields">
                      <label className="field">Packs
                        <input inputMode="numeric" value={line.packs} onChange={(event) => changeLine(line.id, { packs: event.target.value }, false)} />
                      </label>
                      <label className="field">Price per pack (INR)
                        <input inputMode="decimal" value={line.pricePerPack} onChange={(event) => changeLine(line.id, { pricePerPack: event.target.value }, false)} />
                      </label>
                    </div>
                    {line.productId && firstLine[line.productId] === line.id ? (
                      <div className="fields">
                        <label className="field">On hand now (packs)
                          <input
                            inputMode="numeric"
                            autoComplete="off"
                            aria-describedby={`${hintId}-line-${line.id}`}
                            value={shelf[line.productId] ?? String(onHandAfter(products.find((item) => item.productId === line.productId), reading.result.date, addedBy[line.productId]))}
                            onChange={(event) => {
                              const value = event.target.value;
                              setShelf((current) => ({ ...current, [line.productId]: value }));
                            }}
                          />
                        </label>
                        <p className="field-hint on-hand-hint" id={`${hintId}-line-${line.id}`}>
                          {shelfHint(products.find((item) => item.productId === line.productId), shelf[line.productId] !== undefined)}
                        </p>
                      </div>
                    ) : line.productId ? <p className="note">On hand for {line.productName || "this product"} is on its first line.</p> : null}
                  </article>
                )) : <p className="note">No lines left on this receipt.</p>}
              </div>
              <div className="field wide receipt-actions">
                <button className="solid" type="button" onClick={addPurchases} disabled={saving}>{saving ? "Saving…" : "Add these purchases"}</button>
                <button className="ghost" type="button" onClick={clearReading}>Clear this receipt</button>
              </div>
            </div>
          ) : null}
          {showUpload ? (
            <div className="field wide">
              <span>Receipt</span>
              <label
                className="drop"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  takeFile(event.dataTransfer.files?.[0], "receipt");
                }}
              >
                <input
                  ref={receiptFileRef}
                  className="sr-only"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  onChange={(event) => takeFile(event.target.files?.[0], "receipt")}
                />
                <IconFile />
                <span>{upload ? upload.fileName : "Drop a PDF, JPEG, or PNG, or browse"}</span>
                <small>Up to 10 MB. One receipt can contain several purchases.</small>
              </label>
              {uploadPreview && upload?.contentType?.startsWith("image/") ? <img className="receipt-preview" src={uploadPreview} alt="Receipt preview" /> : null}
              {uploadPreview && upload?.contentType === "application/pdf" ? <iframe className="receipt-frame" title={upload.fileName} src={uploadPreview} /> : null}
              {upload ? <button className="texty" type="button" onClick={clearUpload}>Remove receipt</button> : null}
              {upload ? <button className="solid" type="button" onClick={readReceipt} disabled={readBusy}>{readBusy ? "Sending…" : "Read receipt"}</button> : null}
            </div>
          ) : null}
          {reading?.status === "reading" || reading?.status === "failed" ? (
            <button className="ghost" type="button" onClick={clearReading}>Clear this receipt</button>
          ) : null}
          {alert ? <p className="error" role="alert">{alert}</p> : null}
        </div>
      ) : null}

      {form.kind === "purchase" || form.kind === "product" ? (
        <form className="record-form" onSubmit={submit}>
          {form.kind === "purchase" && lastSaved ? (
            <div className="saved-summary" role="status">
              <p>
                <strong>Saved.</strong> {lastSaved.packs} {Number(lastSaved.packs) === 1 ? "pack" : "packs"} of {lastSaved.name} at {rupee(lastSaved.price)} on {indiaDate(lastSaved.date)}
                {lastSaved.hadReceipt ? ", with its receipt." : "."}
                {lastSaved.onHand != null ? ` On hand now ${packs(lastSaved.onHand)}.` : ""}
              </p>
              <p className="note">Add the next one below. The date stays the same.</p>
            </div>
          ) : null}
          <div className="fields">
            {form.kind === "purchase" ? (
              <div className="field wide">
                <span>Receipt <span className="required-mark" aria-hidden="true">*</span><span className="sr-only">, required</span></span>
                <label
                  className={`drop${fileError && !receipt ? " drop-missing" : ""}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    takeFile(event.dataTransfer.files?.[0], "purchase");
                  }}
                >
                  <input
                    ref={purchaseFileRef}
                    className="sr-only"
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    onChange={(event) => takeFile(event.target.files?.[0], "purchase")}
                    aria-required="true"
                    aria-invalid={Boolean(fileError && !receipt)}
                  />
                  <IconFile />
                  <span>{receipt ? receipt.fileName : "Drop a PDF, JPEG, or PNG, or browse"}</span>
                  <small>Required. Up to 10 MB.</small>
                </label>
                {previewUrl && receipt?.contentType?.startsWith("image/") ? <img className="receipt-preview" src={previewUrl} alt="Receipt preview" /> : null}
                {previewUrl && receipt?.contentType === "application/pdf" ? <iframe className="receipt-frame" title={receipt.fileName} src={previewUrl} /> : null}
                {receipt ? <button className="texty" type="button" onClick={clearPurchaseFile}>Remove receipt</button> : null}
                {heldPurchase ? <p className="note">The purchase is saved. Try the receipt again, or attach it from Purchases and receipts.</p> : null}
                {fileError ? <p className="error" role="alert">{fileError}</p> : null}
              </div>
            ) : null}
            {form.kind === "product" ? (
              <label className="field wide">Name
                <input value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field wide">Product
                <select value={form.productId} onChange={(event) => choosePurchaseProduct(event.target.value)} required>
                  <option value="">Choose a product</option>
                  {products.map((product) => (
                    <option key={product.productId} value={product.productId}>{product.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field">Date
                <DateField max={pantry.today} value={form.date} onChange={(date) => setForm({ ...form, date })} required />
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field">Packs
                <input inputMode="numeric" value={form.packs} onChange={(event) => setForm({ ...form, packs: event.target.value })} required />
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field wide">Price per pack (INR)
                <input inputMode="decimal" value={form.price} onChange={(event) => { prefilledPrice.current = ""; setForm({ ...form, price: event.target.value }); }} required />
              </label>
            ) : null}
            {form.kind === "purchase" && prefilledPrice.current && prefilledPrice.current === form.price ? (
              <p className="note field wide">Filled in from the last price this month. Change it if the receipt differs.</p>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field">On hand now (packs)
                <input
                  inputMode="numeric"
                  autoComplete="off"
                  value={onHandValue}
                  disabled={!chosen}
                  aria-describedby={`${hintId}-onhand`}
                  aria-invalid={Boolean(onHandError) || undefined}
                  onChange={(event) => {
                    setOnHandError("");
                    setForm({ ...form, onHand: event.target.value, onHandTouched: true });
                  }}
                />
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <p className="field-hint on-hand-hint" id={`${hintId}-onhand`}>{shelfHint(chosen, form.onHandTouched)}</p>
            ) : null}
            {form.kind === "purchase" && onHandError ? <p className="error field wide" role="alert">{onHandError}</p> : null}
            <div className="field wide">
              <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : heldPurchase ? "Try the receipt again" : "Save"}</button>
            </div>
          </div>
        </form>
      ) : null}

    </section>
  );
}

// What the on-hand box means. It is prefilled with what the pantry expects once
// this purchase is saved; a changed figure is saved as today's count.
function shelfHint(product, touched) {
  if (!product) return "Choose a product to see what should be on the shelf.";
  if (touched) return "Saves as today's count with this purchase.";
  if (product.todayCount != null) return `Today's count is ${packs(product.todayCount)}. Add this purchase if it came in after that count.`;
  return "Expected on the shelf with this purchase put away. Change it if your count differs.";
}

function patchBody(next) {
  return {
    date: next.result?.date || "",
    lines: (next.result?.lines || []).map((line) => ({
      id: line.id,
      productId: line.productId || "",
      packs: line.packs ?? "",
      pricePerPack: line.pricePerPack ?? "",
      discarded: Boolean(line.discarded),
    })),
  };
}

function samePurchase(form, held) {
  return form.productId === held.productId && form.date === held.date && String(form.packs) === String(held.packs) && String(form.price) === String(held.price);
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
