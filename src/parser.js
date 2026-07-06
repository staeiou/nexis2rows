const PAGE_HEADER_RE = /^\s*Page\s+\d+\s+of\s+\d+\s*$/i;
const FOOTER_RE = /\|\s*About LexisNexis\s*\|\s*Privacy Policy\s*\|\s*Terms & Conditions\s*\|\s*Copyright/i;
const ADVANCE_LINK_RE = /^https?:\/\/advance\.lexis\.com\/api\/document/i;

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
  const copyrightIndex = lines.findIndex((line) => /^Copyright\s+\d{4}\s+/i.test(line));

  const title = extractTitle(firstPageLines, firstPage.annotations);
  const publication = compact(lines[copyrightIndex - 2] || "");
  const publication_date = compact(lines[copyrightIndex - 1] || "");
  const metadataLines = lines.slice(copyrightIndex + 1, bodyIndex);
  const bodyLines = lines.slice(bodyIndex + 1, loadDateIndex >= 0 ? loadDateIndex : lines.length);

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
    abstract: extractAbstract(body),
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

function extractAbstract(body) {
  const match = /\bABSTRACT\s+([\s\S]*?)(?:\n\s*FULL TEXT\b|$)/i.exec(body);
  return match ? match[1].trim() : "";
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
