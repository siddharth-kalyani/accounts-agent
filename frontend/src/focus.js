import { useEffect, useRef } from "react";

function focusable(root) {
  return [...root.querySelectorAll("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")]
    // Controls hidden by CSS (display: none) cannot take focus, so they are not stops.
    .filter((node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true" && node.getClientRects().length > 0);
}

// `initial` optionally names the control to focus first, for a dialog whose
// first stop is its close button but whose job is a field further down.
export function useFocusTrap(active, onEscape, initial) {
  const ref = useRef(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    const root = ref.current;
    if (!root) return undefined;
    const previous = document.activeElement;
    const items = focusable(root);
    const first = initial?.current && root.contains(initial.current) ? initial.current : items[0];
    (first instanceof HTMLElement ? first : root).focus();

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable(root);
      if (!nodes.length) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    };
  }, [active]);

  return ref;
}
