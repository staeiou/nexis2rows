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

// Nexis exports more than one kind of document, and they are structurally
// different rather than cosmetically different:
//
//   news  -- has a standalone "Body" line. Covers wire/newspaper articles and
//            the "Primary Sources in U.S. Presidential History" collection,
//            which shares the layout but carries no "Copyright <year>" line and
//            prints its metadata block *below* "Body" instead of above it.
//   case  -- court opinions. No "Body" at all; the text lives under "Opinion",
//            beside Syllabus / Headnotes / Counsel / Dissent, and the masthead
//            slot holds a court rather than a publication.
//
// Requiring a "Body" line to recognize an article start silently produced zero
// rows for a whole export of court cases, so detection keys off either marker.
const CASE_REPORTER_RE = /^Reporter\s*$/im;
const BODY_LINE_RE = /^\s*Body\s*$/im;

function detectDocumentType(text) {
  if (BODY_LINE_RE.test(text)) return "news";
  if (CASE_REPORTER_RE.test(text)) return "case";
  return "";
}

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

// Fields only court cases populate. Listed here so every row carries the same
// shape and the exporters can rely on it.
const CASE_FIELDS = [
  "citation", "caption", "docket", "prior_history", "subsequent_history",
  "disposition", "core_terms", "overview", "headnotes", "syllabus",
  "counsel", "judges", "opinion_by", "concur_by", "concur", "dissent_by", "dissent"
];

function parseArticle(article, ordinal, header, source) {
  const firstPage = article.pages[0] || { text: "", annotations: [] };
  const chunk = article.pages.map((page) => page.text).join("\n\f\n");
  const lines = cleanArticleLines(joinArticlePages(article.pages));
  const firstPageLines = cleanArticleLines(firstPage.text.split(/\n/));
  const documentType = detectDocumentType(chunk) || "news";

  const title = extractTitle(firstPageLines, firstPage.annotations);
  const context = { title, ordinal, pdfName: source.pdfName };
  const parsed =
    documentType === "case" ? parseCaseDocument(lines, context) : parseNewsDocument(lines, context);

  const row = {
    id: null,
    source_archive: source.archiveName || "",
    source_pdf: source.pdfName || "",
    source_sha256: source.sha256 || "",
    nexis_link: extractNexisLink(firstPage.annotations),
    source_article_ordinal: ordinal,
    // 1-based page in the source PDF where this article starts, so any row can
    // be checked against the page it came from.
    source_page: firstPage.pageNumber ?? null,
    document_type: documentType,
    delivery_date: header.delivery_date || "",
    job_number: header.job_number || "",
    search_terms: header.search_terms || "",
    search_type: header.search_type || "",
    title,
    publication: parsed.publication,
    publication_date: parsed.publication_date,
    section: parsed.section || "",
    length: parsed.length || "",
    byline: parsed.byline || "",
    dateline: parsed.dateline || "",
    load_date: parsed.load_date || "",
    body: parsed.body,
    body_sha256: "",
    raw_text: chunk.trim()
  };
  for (const field of CASE_FIELDS) row[field] = parsed[field] || "";
  return row;
}

function parseNewsDocument(lines, context) {
  const bodyIndex = lines.findIndex((line) => line.trim() === "Body");
  const loadDateIndex = findLastIndex(lines, (line) => /^Load-Date:\s*/i.test(line));
  const endOfDocumentIndex = findLastIndex(lines, (line) => /^End of Document\s*$/i.test(line));
  const copyrightIndex = lines.findIndex((line) => /^Copyright\s*(?:©\s*)?\d{4}\b/i.test(line));

  // The masthead block ends at whichever comes first: the "Copyright <year>"
  // line, or the first recognized metadata field. Modern news always hits
  // Copyright first, so this is a no-op there; the presidential collection has
  // no Copyright line at all and lands on its "Length:" line instead.
  const headerEndIndex = findHeaderEnd(lines, copyrightIndex, bodyIndex);
  const { publication, publication_date } = resolvePublication(lines, headerEndIndex, context);

  const metadataStart = copyrightIndex >= 0 && copyrightIndex === headerEndIndex ? copyrightIndex + 1 : headerEndIndex;
  const metadata = parseMetadata(lines.slice(metadataStart, bodyIndex));

  // The body runs from the "Body" marker to the Load-Date line, or to
  // "End of Document" when the article carries no Load-Date.
  const bodyEndIndex = loadDateIndex >= 0 ? loadDateIndex : endOfDocumentIndex >= 0 ? endOfDocumentIndex : lines.length;
  const bodyLines = lines.slice(bodyIndex + 1, bodyEndIndex);
  const bodyStart = skipPrimarySourceMetadata(bodyLines);

  return {
    publication,
    publication_date,
    section: metadata.Section,
    length: metadata.Length,
    byline: metadata.Byline,
    dateline: metadata.Dateline,
    load_date: loadDateIndex >= 0 ? lines[loadDateIndex].replace(/^Load-Date:\s*/i, "").trim() : "",
    body: cleanBody(bodyLines.slice(bodyStart))
  };
}

const HEADER_METADATA_KEY_RE = /^(Section|Length|Byline|Dateline|Highlight|Graphic|Correction|Language|Publication-Type|Journal-Code|Volume|Edition):/i;

function findHeaderEnd(lines, copyrightIndex, bodyIndex) {
  const limit = bodyIndex >= 0 ? bodyIndex : lines.length;
  let firstMetadata = -1;
  for (let index = 0; index < limit; index += 1) {
    if (HEADER_METADATA_KEY_RE.test(lines[index])) {
      firstMetadata = index;
      break;
    }
  }

  if (copyrightIndex >= 0 && (firstMetadata < 0 || copyrightIndex < firstMetadata)) return copyrightIndex;
  if (firstMetadata >= 0) return firstMetadata;
  return limit;
}

// The "Primary Sources in U.S. Presidential History" collection prints its
// bibliographic block *after* the "Body" marker, so the body used to open with
// up to 15 lines of "Document Type: / Author: / Subject Descriptors:". That
// block always ends with the Subject Descriptors list. That list wraps across
// lines and breaks mid-phrase ("... Department of" / "Interior; Emancipation"),
// so a trailing separator does not mark the wrap -- but every wrapped line still
// carries a ";" between items, while the heading that follows the block does
// not. That is the boundary this keys off.
const PRIMARY_SOURCE_OPENER_RE = /^(Document Type|Article Title|Compilation Title):/i;
const SUBJECT_DESCRIPTORS_RE = /^Subject Descriptors:/i;

function skipPrimarySourceMetadata(bodyLines) {
  if (!bodyLines.length || !PRIMARY_SOURCE_OPENER_RE.test(bodyLines[0])) return 0;

  const descriptorsIndex = bodyLines.findIndex((line) => SUBJECT_DESCRIPTORS_RE.test(line));
  // Without the closing marker there is no dependable end, and dropping lines on
  // a guess would eat real text. Leave the body untouched instead.
  if (descriptorsIndex < 0) return 0;

  let end = descriptorsIndex;
  while (end + 1 < bodyLines.length && bodyLines[end + 1].includes(";")) end += 1;
  return end + 1;
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

// Nexis repeats a running head -- the article title, or a case name plus its
// citation -- under "Page N of M" at the top of every continuation page. It is
// furniture, not text, and joining pages naively splices it into the middle of
// the body once per page break. Strip it only on an exact match, so an
// unrecognized layout keeps its text rather than losing a real line.
function joinArticlePages(pages) {
  const perPage = pages.map((page) => String(page.text || "").split(/\n/));
  const first = perPage[0] || [];
  const runningHead = compact(first.find((line) => line.trim() && !PAGE_HEADER_RE.test(line.trim())) || "");

  const merged = [];
  perPage.forEach((lines, index) => {
    if (index === 0) {
      merged.push(...lines);
      return;
    }

    let start = 0;
    while (start < lines.length && (!lines[start].trim() || PAGE_HEADER_RE.test(lines[start].trim()))) start += 1;
    if (runningHead && compact(lines[start] || "") === runningHead) start += 1;
    merged.push(...lines.slice(start));
  });

  return merged;
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
function resolvePublication(lines, headerEndIndex, context) {
  const where = `${context.pdfName || "unknown PDF"}, article ${context.ordinal}, "${context.title}"`;

  if (headerEndIndex <= 0) {
    warn(`no masthead block found (${where}); publication and publication_date left blank`);
    return { publication: "", publication_date: "" };
  }

  let dateIndex = -1;
  for (let i = headerEndIndex - 1; i >= Math.max(0, headerEndIndex - MAX_EDITION_LINES - 1); i--) {
    if (DATE_LINE_RE.test(lines[i] || "")) {
      dateIndex = i;
      break;
    }
  }

  if (dateIndex < 0) {
    warn(`no recognizable date line above the masthead block (${where}); using fixed-offset fallback`);
  }

  const publication = compact((dateIndex >= 0 ? lines[dateIndex - 1] : lines[headerEndIndex - 2]) || "");
  const publication_date = compact((dateIndex >= 0 ? lines[dateIndex] : lines[headerEndIndex - 1]) || "");

  // Both fields landing one line off is the failure mode this logic exists to
  // prevent, and it is cheap to detect after the fact.
  if (!publication) {
    warn(`publication came out blank (${where})`);
  } else if (DATE_LINE_RE.test(publication)) {
    warn(`publication looks like a date: "${publication}" (${where})`);
  }

  return { publication, publication_date };
}

// --- Court cases -----------------------------------------------------------
//
// Layout, verified across a 250-case export:
//
//   Page 1 of N
//   Yick Wo v. Hopkins, 118 U.S. 356          running head
//   Yick Wo v. Hopkins                        title
//   Supreme Court of the United States        court      -> publication
//   Submitted April 14, 1886. ; May 10, ...   date(s)    -> publication_date
//   No Number in Original                     docket
//   Reporter
//   118 U.S. 356 *; 6 S. Ct. 1064 **; ...     citation
//   YICK WO v. HOPKINS, SHERIFF.              caption
//   Prior History: ...
//   Core Terms / Overview / Headnotes / Syllabus / Counsel: / Judges:
//   Opinion by: / Opinion / Concur by: / Concur / Dissent by: / Dissent
//   End of Document
//
// Sections always appear in that relative order, so each one's text is the span
// between its marker and the next marker present.
const CASE_STANDALONE_SECTIONS = [
  ["core_terms", /^Core Terms$/i],
  ["overview", /^Overview$/i],
  ["headnotes", /^(?:LexisNexis\s*(?:®|®)?\s*)?Headnotes$/i],
  ["syllabus", /^Syllabus$/i],
  ["body", /^Opinion$/i],
  ["concur", /^Concur(?:rence)?$/i],
  ["dissent", /^Dissent$/i]
];
const CASE_KEYED_SECTIONS = [
  ["prior_history", /^Prior History:\s*/i],
  ["subsequent_history", /^Subsequent History:\s*/i],
  ["disposition", /^Disposition:\s*/i],
  ["counsel", /^Counsel:\s*/i],
  ["judges", /^Judges:\s*/i],
  ["opinion_by", /^Opinion by:\s*/i],
  ["concur_by", /^Concur(?:rence)? by:\s*/i],
  ["dissent_by", /^Dissent by:\s*/i]
];

const CASE_DATE_RE = new RegExp(`${MONTH}\\b\\s*,?\\s*(?:\\d{1,2}\\s*,?\\s*)?\\d{4}`, "i");
const CASE_YEAR_RE = /\b1[5-9]\d{2}\b|\b20\d{2}\b/;
const CASE_DOCKET_RE = /^(?:Nos?\.|Nos\b|No Number in Original|Case No|Docket)/i;
// Captions are the styled party line: "X v. Y", "Ex parte Z", "In re Z".
const CASE_CAPTION_RE = /\sv\.?\s|^(?:Ex parte|In re|In the Matter of)\b/i;

function parseCaseDocument(lines, context) {
  const where = `${context.pdfName || "unknown PDF"}, article ${context.ordinal}, "${context.title}"`;
  const reporterIndex = lines.findIndex((line) => /^Reporter$/i.test(line));
  const loadDateIndex = findLastIndex(lines, (line) => /^Load-Date:\s*/i.test(line));
  const endOfDocumentIndex = findLastIndex(lines, (line) => /^End of Document\s*$/i.test(line));
  const endIndex = loadDateIndex >= 0 ? loadDateIndex : endOfDocumentIndex >= 0 ? endOfDocumentIndex : lines.length;

  if (reporterIndex < 0) {
    warn(`case document with no "Reporter" line (${where}); publication and publication_date left blank`);
    return { publication: "", publication_date: "", body: cleanBody(lines) };
  }

  // Walk up from "Reporter": an optional docket line, then one or more date
  // lines (they wrap when a case was argued, restored, and reargued), and the
  // first line above those is the court.
  let index = reporterIndex - 1;
  const docket = CASE_DOCKET_RE.test(lines[index] || "") && !CASE_DATE_RE.test(lines[index] || "") ? lines[index--] : "";

  const dateLines = [];
  while (index >= 0 && (CASE_DATE_RE.test(lines[index]) || (dateLines.length && CASE_YEAR_RE.test(lines[index])))) {
    dateLines.unshift(lines[index]);
    index -= 1;
  }
  const publication = compact(lines[index] || "");

  if (!dateLines.length) warn(`no decision date above "Reporter" (${where})`);
  if (!publication) warn(`no court name above the decision date (${where})`);

  const sections = sliceCaseSections(lines, reporterIndex + 1, endIndex);
  const { citation, caption } = splitReporterBlock(lines, reporterIndex + 1, sections.firstMarkerIndex);

  return {
    publication,
    publication_date: compact(dateLines.join(" ")),
    load_date: loadDateIndex >= 0 ? lines[loadDateIndex].replace(/^Load-Date:\s*/i, "").trim() : "",
    docket: compact(docket),
    citation,
    caption,
    ...sections.values,
    body: sections.values.body || ""
  };
}

function sliceCaseSections(lines, startIndex, endIndex) {
  const marks = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    const keyed = CASE_KEYED_SECTIONS.find(([, re]) => re.test(line));
    if (keyed) {
      marks.push({ index, key: keyed[0], inline: line.replace(keyed[1], "").trim() });
      continue;
    }
    const standalone = CASE_STANDALONE_SECTIONS.find(([, re]) => re.test(line));
    if (standalone) marks.push({ index, key: standalone[0], inline: "" });
  }

  const values = {};
  for (let mark = 0; mark < marks.length; mark += 1) {
    const to = mark + 1 < marks.length ? marks[mark + 1].index : endIndex;
    const text = cleanBody([marks[mark].inline, ...lines.slice(marks[mark].index + 1, to)].filter(Boolean));
    // A case can carry several dissents; keep them all rather than the first.
    values[marks[mark].key] = values[marks[mark].key] ? `${values[marks[mark].key]}\n\n${text}` : text;
  }

  return { values, firstMarkerIndex: marks.length ? marks[0].index : endIndex };
}

// Between "Reporter" and the first section marker sit the parallel citations
// (which wrap) and then the party caption.
function splitReporterBlock(lines, startIndex, endIndex) {
  const block = lines.slice(startIndex, Math.max(startIndex, endIndex));
  const captionIndex = block.findIndex((line) => CASE_CAPTION_RE.test(line));
  if (captionIndex < 0) return { citation: compact(block.join(" ")), caption: "" };
  return {
    citation: compact(block.slice(0, captionIndex).join(" ")),
    caption: compact(block.slice(captionIndex).join(" "))
  };
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
  return /^Page\s+1\s+of\s+\d+/im.test(text) && detectDocumentType(text) !== "";
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
