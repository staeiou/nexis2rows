// Small pure helpers shared by the render functions. No DOM access, so they are
// unit-testable from Node (see scripts/test-ui-format.mjs).

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Article bodies run to thousands of words; the table shows head and tail so a
// row stays one line while still hinting at how the text ends.
export function previewText(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= 220) return compact;
  return `${compact.slice(0, 100)} [...] ${compact.slice(-100)}`;
}

// Import failures are surfaced in the UI rather than only the console, so the
// stack is included: users reporting a bad PDF can copy the whole row.
export function describeError(error) {
  if (!error) return "Unknown error";
  const name = error.name ? `${error.name}: ` : "";
  const message = error.message || String(error);
  const stack = error.stack ? `\n${error.stack}` : "";
  return `${name}${message}${stack}`;
}
