import { EmptyState } from "./Illustration.jsx";

// Shown instead of a skeleton when loading failed, so the page never looks
// like it is still loading after the request is over.
export function LoadFailed({ text, onRetry }) {
  return (
    <div role="status">
      <EmptyState
        art="offline"
        className="load-failed"
        title={text}
        actions={onRetry ? <button className="ghost small" type="button" onClick={onRetry}>Try again</button> : null}
      >
        Check your connection, then try again.
      </EmptyState>
    </div>
  );
}

// Placeholder shapes while data loads, so the page does not jump when it arrives.
// Render it only while a request is in flight, never just because data is empty.
export function Skeleton({ label, rows = 3, variant = "list" }) {
  return (
    <div className={`skeleton skeleton-${variant}`} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {variant === "hero" ? (
        <>
          <i className="sk sk-kicker" />
          <i className="sk sk-figure" />
          <i className="sk sk-line short" />
        </>
      ) : (
        Array.from({ length: rows }, (_, index) => (
          <div className="sk-row" key={index} aria-hidden="true">
            <i className="sk sk-title" />
            <i className="sk sk-line" />
            <i className="sk sk-line short" />
          </div>
        ))
      )}
    </div>
  );
}
