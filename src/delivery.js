// Routing for the export matrix: PDF or DOCX, one file or a ZIP, with or
// without the bibliography companions. Everything here is pure -- no DOM, no
// worker, no progress reporting -- so the app (src/main.js) and the test harness
// (scripts/test-delivery.mjs) run identical code.
//
// Nexis's "include bibliography" option ships two extra files beside the
// articles, in whichever format was chosen:
//
//   Files (N)_doclist.{PDF,DOCX}  search provenance + a numbered title list
//   mergedFile_*.{PDF,DOCX}       one citation per document
//
// Neither holds articles. Before this existed both parsed to zero rows with no
// explanation, which is the same silent-zero failure the court-case export hit.
import { classifyDeliveryText, parseDoclistTitles, parseDeliveryHeader } from "./parser.js";
import { readDocx } from "./docx-text.js";

const COMPANION_KINDS = new Set(["doclist", "bibliography"]);

export function isCompanion(classification) {
  return COMPANION_KINDS.has(classification);
}

// The doclist numbers the bibliography among the documents it lists, so a
// delivery of 250 documents lists 251 entries. That last one is the companion
// describing the other 250 -- it is never an article, and counting it would make
// a complete import report itself as one document short. Dropped only when it is
// the final entry, so an article that happens to be titled "Bibliography" is
// still counted.
function dropBibliographySelfEntry(titles) {
  if (!titles.length) return titles;
  const last = titles[titles.length - 1];
  if (/^bibliography$/i.test(String(last.title || "").trim())) return titles.slice(0, -1);
  return titles;
}

// PDF side. The caller has already extracted pages with src/pdf-text.js.
export function readPdfDelivery(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const text = list.map((page) => page.text).join("\n\f\n");
  const classification = classifyDeliveryText(text);

  if (classification === "doclist") {
    const titles = dropBibliographySelfEntry(parseDoclistTitles(text));
    return { classification, pages: list, headerText: list[0]?.text || "", titles, citations: [] };
  }

  if (classification === "bibliography") {
    // One citation per page, under its own "Bibliography" heading.
    const citations = list
      .map((page) =>
        page.text
          .split(/\n/)
          .map((line) => line.trim())
          .filter((line) => line && !/^(?:Bibliography|End of Document)$/i.test(line))
          .join(" ")
      )
      .filter(Boolean);
    return { classification, pages: list, headerText: "", titles: [], citations };
  }

  return { classification, pages: list, headerText: list[0]?.text || "", titles: [], citations: [] };
}

// DOCX side. src/docx-text.js already classifies and segments; this just
// normalises the shape so callers do not branch on format.
export async function readDocxDelivery(bytes) {
  const read = await readDocx(bytes);
  return {
    classification: read.kind === "empty" ? "unknown" : read.kind,
    pages: read.pages || [],
    headerText: read.headerText || "",
    titles: dropBibliographySelfEntry(read.titles || []),
    citations: read.citations || []
  };
}

export function createDeliveryIndex() {
  return new Map();
}

export function recordDelivery(index, key, read) {
  const existing = index.get(key) || { headerText: "", titles: [], citations: [] };
  index.set(key, {
    headerText: read.headerText || existing.headerText,
    titles: read.titles?.length ? read.titles : existing.titles,
    citations: read.citations?.length ? read.citations : existing.citations
  });
}

// A ZIP of individually exported files has no delivery header of its own, so
// those rows come out with blank search_terms / job_number. When a doclist
// shipped in the same archive it carries exactly those fields.
export function fillProvenance(rows, headerText) {
  if (!headerText) return 0;
  const header = parseDeliveryHeader(headerText);
  let filled = 0;
  for (const row of rows) {
    for (const field of ["delivery_date", "job_number", "search_terms", "search_type"]) {
      if (!row[field] && header[field]) {
        row[field] = header[field];
        filled += 1;
      }
    }
  }
  return filled;
}

// The doclist prints titles with their original punctuation; a title recovered
// from a filename has had ":" and "/" replaced and may be truncated. Compare on
// alphanumerics only, and treat a listed title as found if a parsed title starts
// with it (filenames are truncated, never extended).
export function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function reconcileTitles(rows, titles) {
  const parsed = rows.map((row) => normalizeTitle(row.title)).filter(Boolean);
  const missing = titles.filter((entry) => {
    const wanted = normalizeTitle(entry.title);
    if (!wanted) return false;
    return !parsed.some((candidate) => candidate === wanted || candidate.startsWith(wanted) || wanted.startsWith(candidate));
  });
  return { listed: titles.length, found: titles.length - missing.length, missing };
}
