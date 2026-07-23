// Turning a Nexis DOCX export into the same page entries src/pdf-text.js
// produces, so src/parser.js is reused unchanged. Like pdf-text.js this file is
// shared by the app and the Node test harness, so it touches neither the DOM nor
// a worker.
//
// A DOCX has no pages -- Word paginates at render time -- so "page" here means
// "one document's worth of text". That is a better unit anyway: the PDF's page
// breaks are the source of the running-head splicing this reader avoids
// entirely, and every DOCX variant marks its documents explicitly.
import JSZip from "jszip";

const HEADING_STYLE_RE = /^Heading1/i;
const END_OF_DOCUMENT_RE = /^End of Document$/i;
const BIBLIOGRAPHY_RE = /^Bibliography$/i;

// Nexis writes the delivery header as "Key: = value" on the first page of a
// combined export and at the top of a doclist; individually exported files have
// no header at all.
const DELIVERY_KEY_RE = /^(?:User Name|Date and Time|Job Number|Client\/Matter|Search Terms|Search Type):/i;
const DOCUMENTS_DECLARED_RE = /^Documents\s*\((\d+)\)$/i;
const NUMBERED_TITLE_RE = /^(\d+)\.\s+(.*\S)$/;

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, name) => {
    if (XML_ENTITIES[name]) return XML_ENTITIES[name];
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return match;
  });
}

// A paragraph's text is its <w:t> runs in document order, with <w:tab/> and
// <w:br/> treated as the whitespace they render as. Nexis splits runs around
// search-term hits, so run boundaries carry no meaning for the text itself.
function paragraphText(chunk) {
  let text = "";
  const partRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
  let match;
  while ((match = partRe.exec(chunk))) {
    if (match[1] !== undefined) text += decodeXml(match[1]);
    else if (match[0].startsWith("<w:tab")) text += " ";
    else text += "\n";
  }
  return text;
}

export function parseDocumentXml(xml) {
  const paragraphs = [];
  // <w:p> cannot nest, and the non-greedy close will not match </w:pPr>.
  const paragraphRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let match;
  while ((match = paragraphRe.exec(xml))) {
    const chunk = match[0];
    const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(chunk)?.[1] || "";
    for (const line of paragraphText(chunk).split("\n")) {
      const text = line.replace(/\s+/g, " ").trim();
      if (text) paragraphs.push({ style, text });
    }
  }
  return paragraphs;
}

export async function readDocxParagraphs(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Not a Word document: word/document.xml is missing");
  return parseDocumentXml(await entry.async("string"));
}

// Which of the three things Nexis can hand you is this?
//
//   articles      -- one or many documents, each opening with a Heading1 title
//   bibliography  -- the "mergedFile_*" companion: one citation per document
//   doclist       -- the "Files (N)_doclist" companion: search provenance and a
//                    numbered title list
//
// Keyed off content rather than filename, because users rename downloads.
export function classifyDocxParagraphs(paragraphs) {
  if (!paragraphs.length) return "empty";
  if (paragraphs.some((paragraph) => HEADING_STYLE_RE.test(paragraph.style))) return "articles";
  if (paragraphs.some((paragraph) => BIBLIOGRAPHY_RE.test(paragraph.text))) return "bibliography";
  if (paragraphs.some((paragraph) => DOCUMENTS_DECLARED_RE.test(paragraph.text))) return "doclist";
  // A Nexis layout we do not recognise still parses if it marks its documents.
  if (paragraphs.some((paragraph) => END_OF_DOCUMENT_RE.test(paragraph.text))) return "articles";
  return "unknown";
}

// Article boundaries: a Heading1 opens a document and "End of Document" closes
// it. Both markers are present in every export variant observed -- combined
// (250/250, 50/50, 38/38) and individually exported (1/1) -- so neither is
// inferred. Anything above the first Heading1 is the delivery header.
function segmentParagraphs(paragraphs) {
  const starts = [];
  paragraphs.forEach((paragraph, index) => {
    if (HEADING_STYLE_RE.test(paragraph.style)) starts.push(index);
  });

  if (!starts.length) {
    // No semantic headings: fall back to the explicit end marker.
    const documents = [];
    let current = [];
    for (const paragraph of paragraphs) {
      current.push(paragraph);
      if (END_OF_DOCUMENT_RE.test(paragraph.text)) {
        documents.push(current);
        current = [];
      }
    }
    if (current.length) documents.push(current);
    return { header: [], documents };
  }

  const header = paragraphs.slice(0, starts[0]);
  const documents = starts.map((start, index) => {
    const limit = index + 1 < starts.length ? starts[index + 1] : paragraphs.length;
    let end = limit;
    for (let cursor = start; cursor < limit; cursor += 1) {
      if (END_OF_DOCUMENT_RE.test(paragraphs[cursor].text)) {
        end = cursor + 1;
        break;
      }
    }
    return paragraphs.slice(start, end);
  });
  return { header, documents };
}

// The page-entry contract src/parser.js consumes. `articleStart` replaces the
// "Page 1 of N" test the PDF path uses -- DOCX has no page furniture, which is
// the whole point -- and `title` carries the Heading1 the PDF can only recover
// from link annotations.
export function docxParagraphsToPages(paragraphs) {
  const { header, documents } = segmentParagraphs(paragraphs);
  const headerText = header.map((paragraph) => paragraph.text).join("\n");

  const pages = documents.map((document, index) => ({
    pageNumber: index + 1,
    text: document.map((paragraph) => paragraph.text).join("\n"),
    annotations: [],
    articleStart: true,
    title: document.find((paragraph) => HEADING_STYLE_RE.test(paragraph.style))?.text || ""
  }));

  return { headerText, pages };
}

// Provenance from a doclist: the delivery header plus the numbered title list.
// A ZIP of individually exported files has no header of its own, so this is the
// only place those fields survive.
export function parseDoclistParagraphs(paragraphs) {
  const titles = [];
  let declared = null;
  const headerLines = [];

  for (const paragraph of paragraphs) {
    const declaredMatch = DOCUMENTS_DECLARED_RE.exec(paragraph.text);
    if (declaredMatch) {
      declared = Number(declaredMatch[1]);
      headerLines.push(paragraph.text);
      continue;
    }
    if (DELIVERY_KEY_RE.test(paragraph.text)) {
      headerLines.push(paragraph.text);
      continue;
    }
    const numbered = NUMBERED_TITLE_RE.exec(paragraph.text);
    if (numbered) titles.push({ number: Number(numbered[1]), title: numbered[2] });
  }

  return { headerText: headerLines.join("\n"), declared, titles };
}

// Provenance from a bibliography: "Title, Author, Publication, (date)" per
// document. Nexis emits the date as the literal placeholder "(Mmm DD, YYYY)" in
// every entry observed, so only the citation string itself is kept.
export function parseBibliographyParagraphs(paragraphs) {
  const citations = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    if (!BIBLIOGRAPHY_RE.test(paragraphs[index].text)) continue;
    const parts = [];
    for (let cursor = index + 1; cursor < paragraphs.length; cursor += 1) {
      if (BIBLIOGRAPHY_RE.test(paragraphs[cursor].text)) break;
      if (END_OF_DOCUMENT_RE.test(paragraphs[cursor].text)) break;
      parts.push(paragraphs[cursor].text);
    }
    if (parts.length) citations.push(parts.join(" "));
  }
  return { citations };
}

// One call for the app: bytes in, a classified result out.
export async function readDocx(bytes) {
  const paragraphs = await readDocxParagraphs(bytes);
  const kind = classifyDocxParagraphs(paragraphs);

  if (kind === "articles") {
    const { headerText, pages } = docxParagraphsToPages(paragraphs);
    return { kind, headerText, pages, paragraphs };
  }
  if (kind === "doclist") {
    return { kind, ...parseDoclistParagraphs(paragraphs), pages: [], paragraphs };
  }
  if (kind === "bibliography") {
    return { kind, ...parseBibliographyParagraphs(paragraphs), headerText: "", pages: [], paragraphs };
  }
  return { kind, headerText: "", pages: [], paragraphs };
}
