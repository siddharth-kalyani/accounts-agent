// Text fields focused by a click, a tap, or on open (for example the assistant
// or a picker's search box) get a quiet ink border. Keyboard navigation keeps
// the red focus ring. The choice is read from the last input the person used.
const root = document.documentElement;
root.dataset.modality = "pointer";

window.addEventListener("pointerdown", () => {
  root.dataset.modality = "pointer";
}, true);

window.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "");
  const navigation = event.key === "Tab" || event.key.startsWith("Arrow") || event.key === "Escape";
  if (navigation || (!typing && (event.key === "Enter" || event.key === " "))) root.dataset.modality = "keyboard";
}, true);
