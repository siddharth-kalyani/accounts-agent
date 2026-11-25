import { useEffect, useId, useRef, useState } from "react";
import { api, indiaDate, onHandAfter, packs, rupee, wholePacks } from "../api.js";
import { useMounted } from "../hooks.js";
import { IconFile, IconPlus, IconTrash } from "../icons.jsx";
import { rememberSupplier } from "../suppliers.js";
import { DateField } from "./DateField.jsx";
import { ProductLineFields } from "./ProductLine.jsx";
import { ProductList } from "./ProductList.jsx";
import { OTHER, otherProduct } from "./ProductMenu.jsx";
import { CreditToggle, SupplierMenu } from "./PurchaseFields.jsx";
import { Skeleton } from "./Skeleton.jsx";

const KINDS = ["receipt", "purchase", "product"];
const ON_HAND_ERROR = "On hand is a whole number of packs, zero or more.";
const NEED_SUPPLIER = "Choose the supplier for a credit purchase.";

// One product on the Purchase tab. `prefilled` is the price filled in from the
// last purchase.
let lineKeys = 0;
function emptyLine() {
  lineKeys += 1;
  return { key: `line-${lineKeys}`, productId: "", packs: "", price: "", packSize: "", packUnit: "N.A", mrp: "", prefilled: "" };
}

// `onHand` is today's shelf count typed per product id, shown on the first card
// of that product. Only a typed figure is sent, so an expected figure is never
// saved as a count, and the figure sent is always the one on screen.
function emptyBill(date) {
  // Most pantry bills are on credit and cleared at month end.
  return { date, supplier: "", onCredit: true, lines: [emptyLine()], onHand: {} };
}

// Typed amounts may carry thousands separators ("1,234.50"); the API takes plain numbers.
function plainAmount(value) {
  return String(value ?? "").trim().replace(/,/g, "");
}

export function RecordPanel({ pantry, officeId, officeName, onSubmit, onSaved, onToast, busy, loading, initialKind = "receipt" }) {
  const purchaseFileRef = useRef(null);
  const receiptFileRef = useRef(null);
  const readingRef = useRef(null);
  const patchChain = useRef(Promise.resolve());
  const patchTimer = useRef(null);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const mounted = useMounted();
  const [kind, setKind] = useState(KINDS.includes(initialKind) ? initialKind : "receipt");
  const [bill, setBill] = useState(() => emptyBill(pantry?.today || todayIso()));
  // What was just saved, so the next bill starts from a clear summary.
  const [lastSaved, setLastSaved] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fileError, setFileError] = useState("");
  const [billError, setBillError] = useState("");
  const [upload, setUpload] = useState(null);
  const [uploadPreview, setUploadPreview] = useState("");
  const [readError, setReadError] = useState("");
  const [readBusy, setReadBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(null);
  // Receipt review: today's shelf count typed per product, keyed by product id.
  const [shelf, setShelf] = useState({});
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

  // Date, supplier and credit apply to the whole receipt.
  function changeReceipt(patch, immediate) {
    const current = readingRef.current;
    if (!current?.result) return;
    remember({ ...current, result: { ...current.result, ...patch } }, immediate);
  }

  // "Add product" on a receipt: a blank line for an item the reading missed. It
  // has no product until one is picked, and is added with the receipt's purchases.
  function addReceiptLine() {
    const current = readingRef.current;
    if (!current?.result) return;
    const id = `added-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const line = { id, added: true, printed: "", productId: "", productName: "", newName: "", matched: false, packs: "", pricePerPack: "", packSize: "", packUnit: "N.A", mrp: "", discarded: false, note: null, lineTotal: "" };
    remember({ ...current, result: { ...current.result, lines: [...current.result.lines, line] } }, true);
  }

  // A product added from a line's picker: reload the pantry so every picker lists it.
  async function productAdded(saved) {
    try {
      await onSaved?.();
      if (mounted.current) onToast?.(`Added ${saved.name}.`);
    } catch {
      if (mounted.current) onToast?.(`Added ${saved.name}, but the screen could not refresh. Reload to see it in every list.`);
    }
  }

  function changeBillLine(key, patch) {
    setBill((current) => ({ ...current, lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) }));
    setBillError("");
  }

  function choosePurchaseProduct(key, productId, picked) {
    const product = picked || (pantry?.products || []).find((item) => item.productId === productId);
    const last = product?.latestPricePerPack ? String(product.latestPricePerPack) : "";
    setBill((current) => ({
      ...current,
      lines: current.lines.map((line) => {
        if (line.key !== key) return line;
        const untouched = !line.price || line.price === line.prefilled;
        return { ...line, productId, price: untouched ? last : line.price, prefilled: untouched ? last : line.prefilled };
      }),
    }));
    setBillError("");
  }

  function addBillLine() {
    setBill((current) => ({ ...current, lines: [...current.lines, emptyLine()] }));
  }

  function removeBillLine(key) {
    setBill((current) => ({ ...current, lines: current.lines.length > 1 ? current.lines.filter((line) => line.key !== key) : current.lines }));
  }

  async function submitBill(event) {
    event.preventDefault();
    // A bill recorded here needs its receipt. (Receipts stay optional on the
    // server: the assistant and receipt reading create purchases too, and an
    // old purchase can still get a receipt from Purchases.)
    if (!receipt) {
      setFileError("Attach the receipt for this bill.");
      purchaseFileRef.current?.closest(".field")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (bill.onCredit && !bill.supplier.trim()) {
      setBillError(NEED_SUPPLIER);
      return;
    }
    if (bill.lines.some((line) => !line.productId)) {
      setBillError("Choose a product on each card, or remove the card.");
      return;
    }
    if (bill.lines.some((line) => !String(line.packs).trim() || !String(line.price).trim())) {
      setBillError("Enter the price per pack and number of packs on each card.");
      return;
    }
    if (bill.lines.some((line) => line.packUnit !== "N.A" && !String(line.packSize).trim())) {
      setBillError("Enter the qty per pack, or set the unit to N.A.");
      return;
    }
    // Today's count goes with the first card of each product, where its box is.
    const first = {};
    for (const line of bill.lines) first[line.productId] ??= line.key;
    const typed = (productId) => String(bill.onHand[productId] ?? "").trim();
    const counted = Object.keys(first).filter((productId) => typed(productId) !== "");
    if (counted.some((productId) => wholePacks(typed(productId)) == null)) {
      setBillError(ON_HAND_ERROR);
      return;
    }
    setBillError("");
    const result = await onSubmit({
      kind: "bill",
      date: bill.date,
      supplier: bill.supplier.trim(),
      onCredit: bill.onCredit,
      lines: bill.lines.map((line) => ({
        productId: line.productId,
        packs: Number(line.packs),
        pricePerPack: plainAmount(line.price),
        packUnit: line.packUnit,
        packSize: line.packUnit === "N.A" ? "" : String(line.packSize).trim(),
        ...(plainAmount(line.mrp) ? { mrp: plainAmount(line.mrp) } : {}),
        ...(first[line.productId] === line.key && typed(line.productId) !== "" ? { onHand: wholePacks(typed(line.productId)) } : {}),
      })),
    }, receipt);
    if (result === true) {
      const names = bill.lines.map((line) => (pantry?.products || []).find((item) => item.productId === line.productId)?.name || "a product");
      setLastSaved({ names, supplier: bill.supplier.trim(), onCredit: bill.onCredit, date: bill.date, total: billTotal(bill.lines) });
      if (bill.supplier.trim()) rememberSupplier(bill.supplier.trim());
      clearPurchaseFile();
      // Keep the date and supplier: the next bill is often from the same trip.
      setBill({ ...emptyBill(bill.date), supplier: bill.supplier, onCredit: bill.onCredit });
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
    const stop = (message) => {
      setReadError(message);
      setSaving(false);
    };
    if (!lines.length) return stop("Choose at least one line to add.");
    if (lines.some((line) => line.added && !line.productId && line.newName !== OTHER)) return stop("Choose a product on each line you added, or remove it.");
    const other = otherProduct((pantry?.products || []).filter((product) => !product.deletedAt));
    if (!latest.result.date || lines.some((line) => line.packs === "" || line.packs == null || line.pricePerPack === "" || line.pricePerPack == null)) {
      return stop("Enter a date, packs, and a price for each remaining line, or discard it.");
    }
    if (lines.some((line) => (line.packUnit || "N.A") !== "N.A" && !String(line.packSize ?? "").trim())) return stop("Enter the qty per pack, or set the unit to N.A.");
    if (latest.result.onCredit && !String(latest.result.supplier || "").trim()) return stop(NEED_SUPPLIER);
    const kept = new Set(lines.map((line) => line.productId));
    const counts = Object.entries(shelf).filter(([productId, value]) => kept.has(productId) && String(value).trim() !== "");
    if (counts.some(([, value]) => wholePacks(value) == null)) return stop(ON_HAND_ERROR);
    try {
      const saved = await api(`/api/offices/${officeId}/receipt-readings/${latest.readingId}/save`, {
        method: "POST",
        body: {
          date: latest.result.date,
          supplier: String(latest.result.supplier || "").trim(),
          onCredit: Boolean(latest.result.onCredit),
          charges: plainAmount(latest.result.charges),
          discardedShare: latest.result.discardedShare !== false,
          lines: lines.map((line) => ({
            id: line.id,
            // A line with no product goes under Other, added now if the office has none.
            productId: line.productId || other?.productId || "",
            ...(line.productId || other ? {} : { newName: OTHER }),
            packs: line.packs,
            pricePerPack: plainAmount(line.pricePerPack),
            packSize: (line.packUnit || "N.A") === "N.A" ? "" : String(line.packSize ?? "").trim(),
            packUnit: line.packUnit || "N.A",
            mrp: plainAmount(line.mrp),
            // GST and discount are no longer entered on review.
            taxPercent: "",
            discount: "",
          })),
          ...(counts.length ? { counts: counts.map(([productId, value]) => ({ productId, packs: wholePacks(value) })) } : {}),
        },
      });
      const added = saved.productsAdded?.length || 0;
      const productNote = added ? ` ${added} new ${added === 1 ? "product" : "products"} added.` : "";
      onToast?.(`${counts.length ? "Purchases and today's stock added." : "Purchases added."}${productNote}`);
      if (latest.result.supplier) rememberSupplier(String(latest.result.supplier).trim());
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
  const other = otherProduct(products);
  const kinds = [
    ["receipt", "Receipt"],
    ["purchase", "Purchase"],
    ["product", "Product"],
  ];
  const lede = kind === "receipt"
    ? "One receipt can add several purchases. Nothing is saved until you approve it."
    : kind === "product"
      ? `Products at ${officeName}. Add one by name.`
      : `${officeName}. One bill, its receipt, and every product on it.`;
  const visibleLines = (reading?.result?.lines || []).filter((line) => !line.discarded);
  const alert = readError || (reading?.status === "failed" ? reading.error : "");
  const showUpload = !reading || reading.status === "failed";
  // One on-hand box per product, on its first line, counting every line of it.
  const firstLine = {};
  const addedBy = {};
  for (const line of visibleLines) {
    if (!line.productId) continue;
    firstLine[line.productId] ??= line.id;
    addedBy[line.productId] = (addedBy[line.productId] || 0) + (Number(line.packs) || 0);
  }
  const billFirst = {};
  const billAdded = {};
  for (const line of bill.lines) {
    if (!line.productId) continue;
    billFirst[line.productId] ??= line.key;
    billAdded[line.productId] = (billAdded[line.productId] || 0) + (Number(line.packs) || 0);
  }
  const total = billTotal(bill.lines);

  return (
    <section className="card record-card">
      <div className="card-head">
        <div>
          <h2>Record</h2>
          <p className="lede-small">{lede}</p>
        </div>
      </div>
      <div className="choices" role="group" aria-label="What to record">
        {kinds.map(([value, label]) => (
          <button key={value} type="button" className="choice" aria-pressed={kind === value} onClick={() => setKind(value)}>
            {label}
          </button>
        ))}
      </div>
      {reading && kind !== "receipt" ? <p className="note">A receipt is waiting on the Receipt tab.</p> : null}

      {kind === "receipt" ? (
        <div className="receipt-review">
          {reading?.status === "reading" ? (
            <p className="receipt-wait" role="status" aria-live="polite">Reading the receipt…</p>
          ) : null}
          {reading?.status === "ready" && reading.result ? (
            <div className="fields">
              {reading.fileName ? <p className="note field wide receipt-file">{reading.fileName}</p> : null}
              {reading.result.note ? <p className="note field wide">{reading.result.note} Editing packs or price does not redo this check.</p> : null}
              <label className="field">Date
                <DateField max={pantry.today} value={reading.result.date || ""} onChange={(date) => changeReceipt({ date }, false)} />
              </label>
              <div className="field">
                <span>Supplier</span>
                <SupplierMenu officeId={officeId} value={reading.result.supplier || ""} label="Supplier on this receipt" onChange={(supplier) => changeReceipt({ supplier }, true)} />
              </div>
              <div className="field wide">
                <CreditToggle checked={reading.result.onCredit} onChange={(onCredit) => changeReceipt({ onCredit }, true)} />
              </div>
              <div className="field wide receipt-lines">
                {visibleLines.length ? visibleLines.map((line) => {
                  const chosen = products.find((item) => item.productId === line.productId);
                  const name = chosen?.name || line.productName || line.printed || "the added line";
                  const counts = line.productId && firstLine[line.productId] === line.id;
                  // An added line has no product until one is picked; an unmatched line goes under Other.
                  const unpicked = line.added && !line.productId && line.newName !== OTHER;
                  return (
                    <article key={line.id} className={`receipt-line${line.productId || line.added ? "" : " unmatched"}`}>
                      <div className="receipt-line-head">
                        <strong>{line.added ? chosen?.name || "New line" : line.printed}</strong>
                        <span className="line-head-end">
                          {line.added ? <small className="muted">Added by you</small> : line.lineTotal ? <small className="muted">Printed {rupee(line.lineTotal)}</small> : null}
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={line.added ? "Remove" : "Discard"}
                            title={line.added ? "Remove this line" : "Discard this line"}
                            onClick={() => changeLine(line.id, { discarded: true }, true)}
                          >
                            <IconTrash />
                          </button>
                        </span>
                      </div>
                      {line.note ? <p className="note" role="status">{line.note}</p> : null}
                      <ProductLineFields
                        officeId={officeId}
                        products={products}
                        product={line.productId || (unpicked ? null : other?.productId || "")}
                        withOther
                        productLabel={`Product for ${line.added ? "the added line" : line.printed}`}
                        label={name}
                        onProduct={(productId, product) => changeLine(line.id, {
                          productId: productId || "",
                          productName: product?.name || "",
                          matched: Boolean(productId),
                          newName: productId ? "" : OTHER,
                        }, true)}
                        onProductAdded={productAdded}
                        packSize={line.packSize}
                        packUnit={line.packUnit}
                        onPackSize={(patch) => changeLine(line.id, patch, patch.packUnit !== line.packUnit)}
                        packs={line.packs}
                        price={line.pricePerPack}
                        initialTotal={line.lineTotal}
                        onPackPrice={(patch) => changeLine(line.id, {
                          ...("packs" in patch ? { packs: patch.packs } : {}),
                          ...("price" in patch ? { pricePerPack: patch.price } : {}),
                        }, false)}
                        mrp={line.mrp}
                        onMrp={(mrp) => changeLine(line.id, { mrp }, false)}
                        onHand={counts ? {
                          value: shelf[line.productId] ?? String(onHandAfter(chosen, reading.result.date, addedBy[line.productId])),
                          hint: shelfHint(chosen, shelf[line.productId] !== undefined),
                          onChange: (value) => setShelf((current) => ({ ...current, [line.productId]: value })),
                        } : unpicked ? {
                          value: "",
                          disabled: true,
                          hint: shelfHint(null, false),
                          onChange: () => {},
                        } : line.productId ? { elsewhere: `On hand for ${name} is on its first line.` } : null}
                      />
                    </article>
                  );
                }) : <p className="note">No lines left on this receipt.</p>}
                <button className="ghost with-icon add-line" type="button" onClick={addReceiptLine}>
                  <IconPlus /> Add product
                </button>
              </div>
              {visibleLines.length ? (() => {
                const items = Math.round(Number(billTotal(visibleLines.map((line) => ({ packs: line.packs, price: line.pricePerPack })))) * 100);
                // A line added on review and removed again was never on the bill.
                const discarded = (reading.result.lines || []).filter((line) => line.discarded && !line.added).reduce((sum, line) => sum + linePaise(line), 0);
                const charges = chargePaise(reading.result.charges);
                const shared = reading.result.discardedShare !== false;
                // As on the server: lines discarded from the bill take their own share of the charges,
                // unless they were never on it (a duplicate or a misread row).
                const share = shared && charges && discarded > 0 && items > 0 ? Math.round((charges * items) / (items + discarded)) : charges;
                const total = (items + share) / 100;
                return (
                  <div className="field wide receipt-sum">
                    <label className="field receipt-charges">Bill charges (INR)
                      <input
                        inputMode="decimal"
                        autoComplete="off"
                        aria-describedby={`${hintId}-charges`}
                        value={reading.result.charges ?? ""}
                        onChange={(event) => changeReceipt({ charges: event.target.value }, false)}
                      />
                    </label>
                    <small className="field-hint" id={`${hintId}-charges`}>
                      Delivery and other charges on the bill, less bill discounts (enter a discount as -20). They are spread over the prices when you add the purchases. Clear the box if the prices already include them.
                      {share && share !== charges ? ` The products you add take ${rupee((share / 100).toFixed(2))} of them; discarded lines take the rest.` : ""}
                    </small>
                    {charges && discarded > 0 ? (
                      <label className="switch" htmlFor={`${hintId}-share`}>
                        <input
                          id={`${hintId}-share`}
                          type="checkbox"
                          role="switch"
                          checked={shared}
                          onChange={(event) => changeReceipt({ discardedShare: event.target.checked }, true)}
                        />
                        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
                        <span>Discarded lines take their share</span>
                      </label>
                    ) : null}
                    <p className="bill-total">
                      <span className="muted">Bill total</span> <strong>{rupee(total.toFixed(2))}</strong>
                      {reading.result.receiptTotal && Number(reading.result.receiptTotal) !== total ? <small className="muted"> Printed {rupee(reading.result.receiptTotal)}</small> : null}
                    </p>
                    {share ? (
                      <small className="field-hint">
                        Items {rupee((items / 100).toFixed(2))} {share > 0 ? "+" : "−"} {rupee((Math.abs(share) / 100).toFixed(2))} bill charges.
                      </small>
                    ) : null}
                    {share && items <= 0 ? (
                      <p className="error" role="alert">The products being added have no price to spread the bill charges over. Check the prices or clear the charges.</p>
                    ) : share && items + share <= 0 ? (
                      <p className="error" role="alert">The bill discount is more than the products being added. Check the bill charges.</p>
                    ) : null}
                  </div>
                );
              })() : null}
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

      {kind === "product" ? (
        <ProductList officeId={officeId} officeName={officeName} products={products} onSaved={onSaved} onToast={onToast} />
      ) : null}

      {kind === "purchase" ? (
        <form className="record-form" onSubmit={submitBill} noValidate>
          {lastSaved ? (
            <div className="saved-summary" role="status">
              <p>
                <strong>Saved.</strong> {lastSaved.names.length === 1 ? lastSaved.names[0] : `${lastSaved.names.length} products`}
                {lastSaved.supplier ? ` from ${lastSaved.supplier}` : ""} on {indiaDate(lastSaved.date)}, {rupee(lastSaved.total)}
                {lastSaved.onCredit ? " on credit." : "."}
              </p>
              <p className="note">Add the next bill below. The date and supplier stay the same.</p>
            </div>
          ) : null}
          <div className="fields">
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
              {fileError ? <p className="error" role="alert">{fileError}</p> : null}
            </div>
            <label className="field">Date
              <DateField max={pantry.today} value={bill.date} onChange={(date) => setBill((current) => ({ ...current, date }))} required />
            </label>
            <div className="field">
              <span>Supplier</span>
              <SupplierMenu officeId={officeId} value={bill.supplier} label="Supplier on this bill" onChange={(supplier) => { setBill((current) => ({ ...current, supplier })); setBillError(""); }} />
            </div>
            <div className="field wide">
              <CreditToggle checked={bill.onCredit} onChange={(onCredit) => { setBill((current) => ({ ...current, onCredit })); setBillError(""); }} />
            </div>
            <div className="field wide receipt-lines">
              {bill.lines.map((line, index) => {
                const chosen = products.find((product) => product.productId === line.productId);
                const title = chosen?.name || `Product ${index + 1}`;
                const showCount = line.productId && billFirst[line.productId] === line.key;
                const onHandTouched = Boolean(line.productId) && bill.onHand[line.productId] !== undefined;
                const onHandValue = onHandTouched ? bill.onHand[line.productId] : chosen ? String(onHandAfter(chosen, bill.date, billAdded[line.productId])) : "";
                return (
                  <article key={line.key} className="receipt-line purchase-line">
                    <div className="receipt-line-head">
                      <strong>{title}</strong>
                      {bill.lines.length > 1 ? (
                        <button className="icon-button" type="button" aria-label={`Remove ${title}`} title="Remove this product" onClick={() => removeBillLine(line.key)}>
                          <IconTrash />
                        </button>
                      ) : null}
                    </div>
                    <ProductLineFields
                      officeId={officeId}
                      products={products}
                      product={line.productId}
                      productLabel={`Product for ${title}`}
                      label={title}
                      onProduct={(productId, product) => choosePurchaseProduct(line.key, productId, product)}
                      onProductAdded={productAdded}
                      packSize={line.packSize}
                      packUnit={line.packUnit}
                      onPackSize={(patch) => changeBillLine(line.key, patch)}
                      packs={line.packs}
                      price={line.price}
                      onPackPrice={(patch) => changeBillLine(line.key, { ...patch, ...("price" in patch ? { prefilled: line.prefilled === patch.price ? line.prefilled : "" } : {}) })}
                      mrp={line.mrp}
                      onMrp={(mrp) => changeBillLine(line.key, { mrp })}
                      note={line.prefilled && line.prefilled === line.price ? <p className="note">Price filled in from the last price this month. Change it if the bill differs.</p> : null}
                      onHand={showCount || !line.productId ? {
                        value: onHandValue,
                        disabled: !chosen,
                        hint: shelfHint(chosen, onHandTouched),
                        onChange: (value) => {
                          setBill((current) => ({ ...current, onHand: { ...current.onHand, [line.productId]: value } }));
                          setBillError("");
                        },
                      } : { elsewhere: `On hand for ${chosen?.name || "this product"} is on its first card.` }}
                    />
                  </article>
                );
              })}
              <button className="ghost with-icon add-line" type="button" onClick={addBillLine}>
                <IconPlus /> Add product
              </button>
            </div>
            <p className="field wide bill-total">
              <span className="muted">Bill total</span> <strong>{rupee(total)}</strong>
              {bill.onCredit ? <span className="muted"> on credit</span> : null}
            </p>
            {billError ? <p className="error field wide" role="alert">{billError}</p> : null}
            <div className="field wide">
              <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : bill.lines.length > 1 ? `Save ${bill.lines.length} purchases` : "Save"}</button>
            </div>
          </div>
        </form>
      ) : null}
    </section>
  );
}

// A draft line's amount in paise: packs times price, else the printed line total.
function linePaise(line) {
  const count = Number(line.packs);
  const each = Number(plainAmount(line.pricePerPack));
  if (Number.isInteger(count) && count > 0 && plainAmount(line.pricePerPack) !== "" && Number.isFinite(each)) return count * Math.round(each * 100);
  const printed = Number(plainAmount(line.lineTotal));
  return plainAmount(line.lineTotal) !== "" && Number.isFinite(printed) ? Math.round(printed * 100) : 0;
}

// Bill charges as typed, in paise; anything unreadable counts as none. Read as
// the server reads them (`charge_text` and `bill_charges` in receipt_read.py):
// separators, spaces, ₹, INR and Rs are ignored, and the size is rounded before the sign.
function chargePaise(value) {
  const match = /^([-+]?)(\d+(?:\.\d+)?)$/.exec(String(value ?? "").replace(/[,\s₹]|INR|Rs\.?/gi, ""));
  if (!match) return 0;
  const paise = Math.floor(Number(match[2]) * 100 + 0.5);
  return match[1] === "-" ? -paise : paise;
}

function billTotal(lines) {
  const paise = lines.reduce((sum, line) => {
    const count = Number(line.packs);
    const each = Number(String(line.price).replace(/,/g, ""));
    return Number.isInteger(count) && count > 0 && Number.isFinite(each) ? sum + count * Math.round(each * 100) : sum;
  }, 0);
  return (paise / 100).toFixed(2);
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
    supplier: next.result?.supplier || "",
    onCredit: Boolean(next.result?.onCredit),
    charges: next.result?.charges ?? "",
    discardedShare: next.result?.discardedShare !== false,
    lines: (next.result?.lines || []).map((line) => ({
      id: line.id,
      // A line added on review has no product until one is picked; a line the
      // reading could not match goes under Other.
      ...(line.added ? { added: true } : {}),
      productId: line.productId || "",
      newName: line.productId ? "" : line.added ? line.newName || "" : OTHER,
      packs: line.packs ?? "",
      pricePerPack: line.pricePerPack ?? "",
      packSize: line.packSize ?? "",
      packUnit: line.packUnit || "N.A",
      mrp: line.mrp ?? "",
      discarded: Boolean(line.discarded),
    })),
  };
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
