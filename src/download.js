// Exports are produced in memory and handed to the browser as a Blob download.
// Nothing is uploaded anywhere; this is the only way files leave the page.
export function downloadBlob(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
