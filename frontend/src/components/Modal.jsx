import { useId } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../focus.js";
import { IconClose } from "../icons.jsx";

// A dialog over the page. Escape and the close button close it; so does a
// click on the dimmed backdrop, unless something typed would be lost (`dirty`).
// Focus stays inside while it is open, starts on `initialFocus` when given,
// and returns to the opening button on close. It renders on <body>, so card
// and row styles around the opening button never reach it.
export function Modal({ title, lede, onClose, children, className = "", initialFocus, dirty = false }) {
  const titleId = useId();
  const trap = useFocusTrap(true, onClose, initialFocus);
  return createPortal(
    <div className="modal-back" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !dirty) onClose(); }}>
      <div className={`modal ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={trap} tabIndex={-1}>
        <div className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {lede ? <p className="lede-small">{lede}</p> : null}
          </div>
          <button className="icon-button" type="button" aria-label="Close" title="Close" onClick={onClose}><IconClose /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
