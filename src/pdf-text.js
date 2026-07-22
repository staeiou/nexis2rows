// Turning a PDF page into text is shared by the app (src/pdf.js) and the test
// harness (scripts/test-parser.mjs). It lives here, apart from src/pdf.js,
// because src/pdf.js constructs a Web Worker at module load and so cannot be
// imported from Node. Nothing in this file touches the DOM or a worker: callers
// open the pdf.js document themselves and pass it in.

// pdf.js returns positioned text runs, not lines. Group runs whose baselines are
// within 2.5pt into one row, order rows top-down and runs left-to-right, and the
// result is the page as a human reads it -- which is what the parser expects,
// since it keys off lines like "Body" and "Copyright <year>".
export function itemsToText(items) {
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

// Article titles and the canonical Nexis permalink are only recoverable from
// link annotations, so they travel alongside each page's text.
export async function readPage(pdfDocument, pageNumber) {
  const page = await pdfDocument.getPage(pageNumber);
  const content = await page.getTextContent({ normalizeWhitespace: true });
  const annotations = await page.getAnnotations();

  return {
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
  };
}

export async function readPages(pdfDocument, onProgress = () => {}) {
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    pages.push(await readPage(pdfDocument, pageNumber));
    onProgress({ pageNumber, pageCount: pdfDocument.numPages });
  }
  return pages;
}
