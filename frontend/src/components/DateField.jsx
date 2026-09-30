import { indiaDate } from "../api.js";
import { IconCalendar } from "../icons.jsx";

// A native date input shown in the app's India format. The browser's own
// field (which follows the device locale, often mm/dd/yyyy) stays underneath
// for the picker and keyboard entry; the visible text is always "7 Jul 2026".
export function DateField({ value, onChange, className = "", placeholder = "Choose a date", ...input }) {
  return (
    <span className={`date-field ${className}`.trim()}>
      <span className={value ? "date-text" : "date-text pick-placeholder"} aria-hidden="true">{value ? indiaDate(value) : placeholder}</span>
      <IconCalendar />
      <input
        {...input}
        className="date-native"
        type="date"
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        onClick={(event) => {
          try {
            event.currentTarget.showPicker?.();
          } catch {
            /* the browser opens its own picker */
          }
        }}
      />
    </span>
  );
}
