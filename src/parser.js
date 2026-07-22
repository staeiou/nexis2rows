const PAGE_HEADER_RE = /^\s*Page\s+\d+\s+of\s+\d+\s*$/i;
const FOOTER_RE = /\|\s*About LexisNexis\s*\|\s*Privacy Policy\s*\|\s*Terms & Conditions\s*\|\s*Copyright/i;
const ADVANCE_LINK_RE = /^https?:\/\/advance\.lexis\.com\/api\/document/i;
// Observed maximum in real exports is 1 ("Late Edition - Final"); 3 leaves
// headroom without letting the date search wander up into the headline.
const MAX_EDITION_LINES = 3;
// Nexis prints the date on its own line between the publication name and the
// "Copyright <year>" line. Anchoring on real month names (rather than "any
// capitalized word") keeps headline text like "Hamas 2026 Offensive" from being
// mistaken for a date when the real date line is in an unrecognized format.
const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Sept|Sep|Aug|Oct|Nov|Dec)\\.?";
const DATE_LINE_RE = new RegExp(
  "^(?:" +
    `${MONTH}\\b\\s+\\d{1,2},?\\s+\\d{4}` + // July 19, 2026
    `|\\d{1,2}\\.?\\s+${MONTH}\\b\\s+\\d{4}` + // 19 July 2026
    `|${MONTH}\\b\\s+\\d{4}` + // July 2026
    "|\\d{4}-\\d{2}-\\d{2}" + // 2026-07-19
    ")\\b",
  "i"
);

export function parseNexisPdfText(text, source = {}, pageData = null) {
  const pages = Array.isArray(pageData) ? pageData : null;
  const pageEntries = buildPageEntries(text, pages);
  const header = parseDeliveryHeader(pageEntries[0]?.text || "");
  const articles = [];
  let currentArticle = null;

  for (const page of pageEntries) {
    if (isArticleStartPage(page.text)) {
      if (currentArticle) articles.push(currentArticle);
      currentArticle = { pages: [page] };
    } else if (currentArticle) {
      currentArticle.pages.push(page);
    }

    if (currentArticle && /End of Document/i.test(page.text)) {
      articles.push(currentArticle);
      currentArticle = null;
    }
  }

  if (currentArticle) articles.push(currentArticle);

  return articles.map((article, index) => parseArticle(article, index + 1, header, source));
}

export function parseDeliveryHeader(text) {
  return {
    delivery_date: firstMatch(text, /^\s*Date and Time:\s*=\s*(.+?)\s*$/im),
    job_number: firstMatch(text, /^\s*Job Number:\s*=\s*(.+?)\s*$/im),
    search_terms: firstMatch(text, /^\s*Search Terms:\s*(.+?)\s*$/im),
    search_type: firstMatch(text, /^\s*Search Type:\s*(.+?)\s*$/im),
    documents_declared: numberOrNull(firstMatch(text, /^\s*Documents\s*\((\d+)\)\s*$/im))
  };
}

function parseArticle(article, ordinal, header, source) {
  const firstPage = article.pages[0] || { text: "", annotations: [] };
  const chunk = article.pages.map((page) => page.text).join("\n\f\n");
  const lines = cleanArticleLines(chunk.split(/\n/));
  const firstPageLines = cleanArticleLines(firstPage.text.split(/\n/));
  const bodyIndex = lines.findIndex((line) => line.trim() === "Body");
  const loadDateIndex = findLastIndex(lines, (line) => /^Load-Date:\s*/i.test(line));
  const endOfDocumentIndex = findLastIndex(lines, (line) => /^End of Document\s*$/i.test(line));
  const copyrightIndex = lines.findIndex((line) => /^Copyright\s*(?:©\s*)?\d{4}\b/i.test(line));

  const title = extractTitle(firstPageLines, firstPage.annotations);
  const { publication, publication_date } = resolvePublication(lines, copyrightIndex, {
    title,
    ordinal,
    pdfName: source.pdfName
  });
  const metadataLines = lines.slice(copyrightIndex + 1, bodyIndex);
  // The body runs from the "Body" marker to the Load-Date line, or to
  // "End of Document" when the article carries no Load-Date.
  const bodyEndIndex = loadDateIndex >= 0 ? loadDateIndex : endOfDocumentIndex >= 0 ? endOfDocumentIndex : lines.length;
  const bodyLines = lines.slice(bodyIndex + 1, bodyEndIndex);

  const metadata = parseMetadata(metadataLines);
  const body = cleanBody(bodyLines);
  const loadDate = loadDateIndex >= 0 ? lines[loadDateIndex].replace(/^Load-Date:\s*/i, "").trim() : "";
  const nexisLink = extractNexisLink(firstPage.annotations);

  return {
    id: null,
    source_archive: source.archiveName || "",
    source_pdf: source.pdfName || "",
    source_sha256: source.sha256 || "",
    nexis_link: nexisLink,
    source_article_ordinal: ordinal,
    delivery_date: header.delivery_date || "",
    job_number: header.job_number || "",
    search_terms: header.search_terms || "",
    search_type: header.search_type || "",
    title,
    publication,
    publication_date,
    section: metadata.Section || "",
    length: metadata.Length || "",
    byline: metadata.Byline || "",
    dateline: metadata.Dateline || "",
    load_date: loadDate,
    body,
    body_sha256: "",
    raw_text: chunk.trim()
  };
}

// XML 1.0 Char production (used by the xlsx export) excludes C0 controls
// other than tab/CR/LF and the Unicode noncharacters U+FFFE/U+FFFF. PDF.js
// emits U+FFFF when a font glyph has no Unicode mapping, and the xlsx
// library writes it through unescaped, corrupting the exported .xlsx file.
export function sanitizeXmlText(text) {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\ufffe\uffff]/g, "");
}

function normalizeText(text) {
  return sanitizeXmlText(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function cleanArticleLines(lines) {
  return lines
    .map((line) => line.replace(/\f/g, "").trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !PAGE_HEADER_RE.test(trimmed) && !FOOTER_RE.test(trimmed);
    })
    .filter((line, index, all) => {
      const trimmed = compact(line);
      const next = compact(all[index + 1] || "");
      return !(trimmed && trimmed === next && index < 2);
    });
}

// The block above "Copyright <year>" is: publication name, date, then zero or
// more edition lines ("Late Edition - Final"). Anchoring on the date line and
// taking the publication from directly above it handles any number of edition
// lines; the fixed-offset fallback covers date formats we don't recognize.
function resolvePublication(lines, copyrightIndex, context) {
  const where = `${context.pdfName || "unknown PDF"}, article ${context.ordinal}, "${context.title}"`;

  if (copyrightIndex < 0) {
    warn(`no "Copyright <year>" line found (${where}); publication and publication_date left blank`);
    return { publication: "", publication_date: "" };
  }

  let dateIndex = -1;
  for (let i = copyrightIndex - 1; i >= Math.max(0, copyrightIndex - MAX_EDITION_LINES - 1); i--) {
    if (DATE_LINE_RE.test(lines[i] || "")) {
      dateIndex = i;
      break;
    }
  }

  if (dateIndex < 0) {
    warn(`no recognizable date line above "Copyright" (${where}); using fixed-offset fallback`);
  }

  const publication = compact((dateIndex >= 0 ? lines[dateIndex - 1] : lines[copyrightIndex - 2]) || "");
  const publication_date = compact((dateIndex >= 0 ? lines[dateIndex] : lines[copyrightIndex - 1]) || "");

  // Both fields landing one line off is the failure mode this logic exists to
  // prevent, and it is cheap to detect after the fact.
  if (!publication) {
    warn(`publication came out blank (${where})`);
  } else if (DATE_LINE_RE.test(publication)) {
    warn(`publication looks like a date: "${publication}" (${where})`);
  }

  return { publication, publication_date };
}

function warn(message) {
  console.warn(`nexis2rows: ${message}`);
}

function parseMetadata(lines) {
  const metadata = {};
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z -]*):\s*(.*)$/.exec(line.trim());
    if (match) metadata[match[1].trim()] = match[2].trim();
  }
  return metadata;
}

function buildPageEntries(text, pages) {
  if (Array.isArray(pages) && pages.length) {
    return pages.map((page, index) => ({
      pageNumber: page.pageNumber ?? index + 1,
      text: normalizeText(page.text || ""),
      annotations: Array.isArray(page.annotations) ? page.annotations : []
    }));
  }

  return String(text || "")
    .split(/\n\f\n/)
    .map((pageText, index) => ({
      pageNumber: index + 1,
      text: normalizeText(pageText),
      annotations: []
    }));
}

function isArticleStartPage(text) {
  return /^Page\s+1\s+of\s+\d+/im.test(text) && /\n\s*Body\s*\n/i.test(text);
}

function extractTitle(lines, annotations) {
  const titleAnnotations = (annotations || [])
    .filter((annotation) => ADVANCE_LINK_RE.test(annotation.url || "") && compact(annotation.overlaidText || ""))
    .sort((a, b) => {
      const ay = Array.isArray(a.rect) ? a.rect[3] || 0 : 0;
      const by = Array.isArray(b.rect) ? b.rect[3] || 0 : 0;
      if (by !== ay) return by - ay;
      const ax = Array.isArray(a.rect) ? a.rect[0] || 0 : 0;
      const bx = Array.isArray(b.rect) ? b.rect[0] || 0 : 0;
      return ax - bx;
    });
  const titleBandTop = titleAnnotations.length ? (Array.isArray(titleAnnotations[0].rect) ? titleAnnotations[0].rect[3] || 0 : 0) : 0;
  const titleFromLinks = compact(
    titleAnnotations
      .filter((annotation) => {
        const top = Array.isArray(annotation.rect) ? annotation.rect[3] || 0 : 0;
        return top >= titleBandTop - 72;
      })
      .map((annotation) => compact(annotation.overlaidText || ""))
      .join(" ")
  );

  if (titleFromLinks) return titleFromLinks;
  return compact(lines[0] || "");
}

function extractNexisLink(annotations) {
  const matches = (annotations || [])
    .filter((annotation) => ADVANCE_LINK_RE.test(annotation.url || ""))
    .sort((a, b) => {
      const ay = Array.isArray(a.rect) ? a.rect[3] || 0 : 0;
      const by = Array.isArray(b.rect) ? b.rect[3] || 0 : 0;
      if (by !== ay) return by - ay;
      const ax = Array.isArray(a.rect) ? a.rect[0] || 0 : 0;
      const bx = Array.isArray(b.rect) ? b.rect[0] || 0 : 0;
      return ax - bx;
    });

  return matches[0]?.url || "";
}

function cleanBody(lines) {
  const cleaned = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (PAGE_HEADER_RE.test(trimmed)) continue;
    if (FOOTER_RE.test(trimmed)) continue;
    cleaned.push(trimmed);
  }
  return cleaned.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function firstMatch(text, regex) {
  const match = regex.exec(text);
  return match ? match[1].trim() : "";
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}
