const PAGE_HEADER_RE = /^\s*Page\s+\d+\s+of\s+\d+\s*$/i;
const FOOTER_RE = /\|\s*About LexisNexis\s*\|\s*Privacy Policy\s*\|\s*Terms & Conditions\s*\|\s*Copyright/i;

export function parseNexisPdfText(text, source = {}) {
  const normalized = normalizeText(text);
  const header = parseDeliveryHeader(normalized);
  const bodyStart = findBodyStart(normalized);
  const articleText = bodyStart >= 0 ? normalized.slice(bodyStart) : normalized;
  const chunks = articleText
    .split(/\n\s*End of Document\s*(?:\n|\f|$)/i)
    .map((chunk) => chunk.trim())
    .filter((chunk) => /^Page\s+1\s+of\s+\d+/im.test(chunk) && /\n\s*Body\s*\n/i.test(chunk));

  return chunks.map((chunk, index) => parseArticle(chunk, index + 1, header, source));
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

function parseArticle(chunk, ordinal, header, source) {
  const lines = cleanArticleLines(chunk.split(/\n/));
  const bodyIndex = lines.findIndex((line) => line.trim() === "Body");
  const loadDateIndex = findLastIndex(lines, (line) => /^Load-Date:\s*/i.test(line));
  const copyrightIndex = lines.findIndex((line) => /^Copyright\s+\d{4}\s+/i.test(line));

  const title = compact(lines[copyrightIndex - 3] || lines[0] || "");
  const publication = compact(lines[copyrightIndex - 2] || "");
  const publication_date = compact(lines[copyrightIndex - 1] || "");
  const metadataLines = lines.slice(copyrightIndex + 1, bodyIndex);
  const bodyLines = lines.slice(bodyIndex + 1, loadDateIndex >= 0 ? loadDateIndex : lines.length);

  const metadata = parseMetadata(metadataLines);
  const body = cleanBody(bodyLines);
  const loadDate = loadDateIndex >= 0 ? lines[loadDateIndex].replace(/^Load-Date:\s*/i, "").trim() : "";

  return {
    id: null,
    source_archive: source.archiveName || "",
    source_pdf: source.pdfName || "",
    source_sha256: source.sha256 || "",
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
    load_date: loadDate,
    body,
    abstract: extractAbstract(body),
    body_sha256: "",
    raw_text: chunk.trim()
  };
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function findBodyStart(text) {
  const match = /\f?\s*Page\s+1\s+of\s+\d+\s*\n/i.exec(text);
  return match ? match.index : -1;
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
