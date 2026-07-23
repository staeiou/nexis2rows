// Print parsed rows verbatim, with the PDF page each came from, so output can be
// checked against the source page by eye.
//
//   node scripts/dump-articles.mjs tests/foo.PDF            # coverage summary
//   node scripts/dump-articles.mjs tests/foo.PDF 1,7,412    # those articles, full
//
// Uses src/parser.js and src/pdf-text.js -- the same code the app runs -- so
// what this prints is what an export would contain.

import fs from "node:fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseNexisPdfText } from "../src/parser.js";
import { readPages } from "../src/pdf-text.js";

const [file, wanted] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/dump-articles.mjs <pdf> [ordinals]");
  process.exit(1);
}

const pdf = await pdfjsLib.getDocument({
  data: new Uint8Array(fs.readFileSync(file)),
  disableWorker: true,
  // pdf.js ships standard_fonts as .pfb but asks for .ttf, so it warns once per
  // font per file. Text extraction does not use glyph data, so the warnings are
  // noise that buries real output; ERRORS-only keeps genuine failures visible.
  standardFontDataUrl: new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href,
  verbosity: pdfjsLib.VerbosityLevel.ERRORS
}).promise;
const pages = await readPages(pdf);
const articles = parseNexisPdfText(pages.map((page) => page.text).join("\n\f\n"), { pdfName: file }, pages);

const SKIP = new Set(["id", "raw_text", "body_sha256", "source_archive", "source_sha256"]);

if (wanted) {
  for (const ordinal of wanted.split(",").map(Number)) {
    const article = articles[ordinal - 1];
    if (!article) continue;
    console.log(`\n########## article ${article.source_article_ordinal}  |  PDF page ${article.source_page}  |  ${article.document_type}`);
    for (const [key, value] of Object.entries(article)) {
      if (SKIP.has(key)) continue;
      const text = typeof value === "string" && value.length > 400 ? `${value.slice(0, 400)}… (${value.length} chars)` : value;
      console.log(`  ${key} = ${JSON.stringify(text)}`);
    }
  }
} else {
  console.log(`${file}: ${pages.length} pages, ${articles.length} articles`);
  const types = new Map();
  for (const article of articles) types.set(article.document_type, (types.get(article.document_type) || 0) + 1);
  console.log(`document types: ${[...types].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  console.log(`\nfield population (of ${articles.length}):`);
  for (const key of Object.keys(articles[0] || {})) {
    if (SKIP.has(key)) continue;
    const filled = articles.filter((article) => article[key] !== "" && article[key] != null).length;
    if (filled) console.log(`  ${String(filled).padStart(5)}  ${key}`);
  }
}
