import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function extractPdfText(data, onProgress = () => {}) {
  const pages = await extractPdfPages(data, onProgress);
  return pages.map((page) => page.text).join("\n\f\n");
}

export async function extractPdfPages(data, onProgress = () => {}) {
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ normalizeWhitespace: true });
    const annotations = await page.getAnnotations();
    pages.push({
      pageNumber,
      text: itemsToText(content.items),
      annotations: annotations
        .filter((annotation) => annotation.subtype === "Link")
        .map((annotation) => ({
          subtype: annotation.subtype,
          url: annotation.url || "",
          unsafeUrl: annotation.unsafeUrl || "",
          overlaidText: annotation.overlaidText || "",
          rect: Array.isArray(annotation.rect) ? [...annotation.rect] : []
        }))
    });
    onProgress({ pageNumber, pageCount: pdf.numPages });
  }

  return pages;
}

function itemsToText(items) {
  const rows = [];
  for (const item of items) {
    const x = item.transform[4];
    const y = item.transform[5];
    let row = rows.find((candidate) => Math.abs(candidate.y - y) < 2.5);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, text: item.str });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) =>
      row.parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}
