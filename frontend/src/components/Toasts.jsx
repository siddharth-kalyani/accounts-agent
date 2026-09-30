import { useEffect, useRef, useState } from "react";
import { IconClose } from "../icons.jsx";

export function ToastStack({ toasts, onDismiss, onUndo }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} onUndo={onUndo} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss, onUndo }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration || 4000);
  const started = useRef(0);
  const error = toast.tone === "error";

  useEffect(() => {
    if (error || paused) return undefined;
    started.current = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started.current));
    };
  }, [error, paused, toast.id, onDismiss]);

  return (
    <div
      className={`toast ${error ? "error-toast" : "ok-toast"}`}
      role={error ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <p>{toast.text}</p>
      {toast.undo ? (
        <button type="button" className="toast-action" onClick={() => onUndo?.(toast.id)}>Undo</button>
      ) : null}
      <button type="button" className="toast-close" aria-label="Close" onClick={() => onDismiss(toast.id)}>
        <IconClose />
      </button>
    </div>
  );
}
