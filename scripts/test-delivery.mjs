// Export-matrix regression tests: PDF or DOCX, a single file or a ZIP, with or
// without the bibliography companions -- driven against fixtures/, which holds
// the same 100 articles exported all eight ways.
//
// Fixtures are copyrighted Nexis content and are deliberately NOT committed.
// Anything absent is skipped with a notice rather than failing, so `npm test`
// still passes on a fresh clone.
//
// This drives the same modules the app does -- src/delivery.js routes, and
// src/pdf-text.js / src/docx-text.js read -- so a pass means the app would
// behave identically. The only thing not exercised here is src/main.js's
// progress reporting and DOM state.

import assert from "node:assert/strict";
import fs from "node:fs";
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPages } from "../src/pdf-text.js";
import { parseNexisPdfText } from "../src/parser.js";
import {
  readPdfDelivery,
  readDocxDelivery,
  createDeliveryIndex,
  recordDelivery,
  fillProvenance,
  reconcileTitles,
  isCompanion
} from "../src/delivery.js";

const STANDARD_FONTS = new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;
const DOCUMENTS = 100;

function kindOf(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "PDF";
  if (lower.endsWith(".docx")) return "DOCX";
  return "";
}

async function readOne(bytes, kind) {
  if (kind === "DOCX") return readDocxDelivery(bytes);
  const pdf = await pdfjsLib.getDocument({
    data: bytes,
    disableWorker: true,
    standardFontDataUrl: STANDARD_FONTS,
    // See scripts/test-parser.mjs: the standard-font warnings are noise here.
    verbosity: pdfjsLib.VerbosityLevel.ERRORS
  }).promise;
  return readPdfDelivery(await readPages(pdf));
}

// Mirrors src/main.js's importSource loop: read, route, parse, then fold in any
// provenance the companions supplied. Works for a single file too -- passed as
// a one-entry list -- since fillProvenance is a no-op when no companion for
// that archive was ever recorded.
async function importAll(entries, archiveName) {
  const deliveries = createDeliveryIndex();
  const articles = [];
  const companions = [];

  for (const entry of entries) {
    const read = await readOne(entry.bytes, entry.kind);
    if (isCompanion(read.classification)) {
      recordDelivery(deliveries, archiveName, read);
      companions.push({ name: entry.name, classification: read.classification, read });
      continue;
    }
    assert.equal(read.classification, "articles", `${entry.name} classified as ${read.classification}`);
    const text = read.pages.map((page) => page.text).join("\n\f\n");
    articles.push(
      ...parseNexisPdfText(text, { archiveName, pdfName: entry.name }, read.pages, { headerText: read.headerText })
    );
  }

  const delivery = deliveries.get(archiveName);
  if (delivery) fillProvenance(articles, delivery.headerText);
  return { articles, companions, delivery };
}

async function readZipEntries(path) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path));
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && kindOf(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const out = [];
  for (const entry of entries) {
    out.push({ name: entry.name, kind: kindOf(entry.name), bytes: await entry.async("uint8array") });
  }
  return out;
}

// A single file behaves like a one-entry archive: importAll needs no branching.
function singleFileEntries(path, name) {
  return [{ name, kind: kindOf(name), bytes: new Uint8Array(fs.readFileSync(path)) }];
}

function assertHealthy(articles, label) {
  assert.equal(articles.length, DOCUMENTS, `${label} parsed ${articles.length} articles`);
  for (const article of articles) {
    const where = `${label} article ${article.source_article_ordinal} ("${article.title}")`;
    assert.ok(article.title, `${where} has no title`);
    assert.ok(article.publication, `${where} has no publication`);
    assert.ok(article.publication_date, `${where} has no publication_date`);
    assert.ok(article.body, `${where} has no body`);
    assert.doesNotMatch(article.body, /End of Document/, `${where} body ran past End of Document`);
    assert.doesNotMatch(article.body, /^Page \d+ of \d+$/m, `${where} body kept page furniture`);
    // The single-file+bibliography variant embeds 100 citations ahead of the
    // articles (see below); confirm none of that leaked into a body.
    assert.doesNotMatch(article.body, /^Bibliography$/m, `${where} body absorbed bibliography text`);
  }
}

const results = { ran: 0, skipped: 0 };
const titleSets = {};

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function fixture(file, run) {
  const path = new URL(`../fixtures/${file}`, import.meta.url);
  if (!fs.existsSync(path)) {
    console.log(`SKIP  ${file} (not present in fixtures/)`);
    results.skipped += 1;
    return;
  }
  await run(path);
  results.ran += 1;
}

// ------------------------------------------------------------------ ZIPs
// A ZIP of individually exported files always carries a doclist (delivery
// header + numbered title list) -- that is not the "bibliography" toggle.
// "Include bibliography" only adds a second companion, the citations file
// (named "Bibliography.*" in these fixtures; the classifier is content-based,
// so the name does not matter). Without it, the doclist alone still restores
// search_terms / job_number: a "without bibliography" ZIP is NOT a blank-
// provenance case.
for (const [file, format, hasBibliography] of [
  ["nexis-pdf-zip-with-biblio.ZIP", "PDF", true],
  ["nexis-pdf-zip-without-biblio.ZIP", "PDF", false],
  ["nexis-docx-zip-with-biblio.ZIP", "DOCX", true],
  ["nexis-docx-zip-without-biblio.ZIP", "DOCX", false]
]) {
  await fixture(file, async (path) => {
    const entries = await readZipEntries(path);
    assert.equal(entries.length, DOCUMENTS + (hasBibliography ? 2 : 1), `${file} entry count`);

    const { articles, companions, delivery } = await importAll(entries, file);
    assertHealthy(articles, file);

    const classifications = companions.map((companion) => companion.classification).sort();
    assert.deepEqual(
      classifications,
      hasBibliography ? ["bibliography", "doclist"] : ["doclist"],
      `${file} companions: ${companions.map((c) => `${c.name}=${c.classification}`).join(", ")}`
    );
    if (hasBibliography) {
      const bibliography = companions.find((companion) => companion.classification === "bibliography");
      assert.equal(bibliography.read.citations.length, DOCUMENTS, `${file} citation count`);
    }

    // The doclist numbers the bibliography companion among its own entries
    // when one shipped, so a delivery of 100 documents lists 101; src/delivery.js
    // drops that self-reference either way, so this is 100 regardless.
    assert.equal(delivery.titles.length, DOCUMENTS, `${file} doclist entry count`);
    const { found, missing } = reconcileTitles(articles, delivery.titles);
    assert.deepEqual(missing, [], `${file} unmatched: ${missing.map((m) => m.title).join(" | ")}`);
    assert.equal(found, DOCUMENTS);

    // Individually exported files carry no header of their own; the doclist
    // restores it, with or without the bibliography.
    for (const article of articles) {
      assert.equal(article.search_terms, "the", `${file} row lost its search terms`);
      assert.ok(article.job_number, `${file} row lost its job number`);
    }

    titleSets[file] = new Set(articles.map((article) => normalizeTitle(article.title)));
    console.log(`PASS  ${file} (${DOCUMENTS} documents + doclist${hasBibliography ? " + bibliography" : ""}, ${format} in a ZIP)`);
  });
}

// -------------------------------------------------------------- single files
// A combined ("save as one file") export carries its own delivery header, so
// no doclist is needed for provenance. With "include bibliography" on, Nexis
// does NOT ship a separate companion here -- it prepends all 100 citations,
// each under its own "Bibliography" heading with a numbered title list, ahead
// of the articles, inside the same file. src/docx-text.js's segmentParagraphs
// (and the PDF side's page classification) treats everything before the first
// article as one opaque header blob, so that embedded citation block is
// discarded today: titles.length and citations.length are 0 below, on
// purpose, documenting a real gap rather than a bug -- open decision, not
// fixed here. The articles themselves are unaffected: 100 parse cleanly with
// direct provenance, and no citation text leaks into a body (see
// assertHealthy).
for (const [file, format, hasBibliography] of [
  ["nexis-pdf-singlefile-with-biblio.PDF", "PDF", true],
  ["nexis-pdf-singlefile-without-biblio.PDF", "PDF", false],
  ["nexis-docx-singlefile-with-biblio.docx", "DOCX", true],
  ["nexis-docx-singlefile-without-biblio.docx", "DOCX", false]
]) {
  await fixture(file, async (path) => {
    const { articles, companions, delivery } = await importAll(singleFileEntries(path, file), file);
    assertHealthy(articles, file);
    assert.equal(companions.length, 0, `${file} should not classify as a companion`);
    assert.equal(delivery, undefined, `${file} is not an archive with a recorded companion`);

    // Provenance comes directly from the file's own header via
    // parseNexisPdfText's headerText option, not fillProvenance.
    assert.ok(articles.every((article) => !/^User Name:/.test(article.title)));
    assert.equal(articles[0].search_terms.toLowerCase(), "the", `${file} lost its search terms`);
    assert.ok(articles[0].job_number, `${file} lost its job number`);

    if (format === "DOCX") assert.doesNotMatch(
      articles.map((a) => a.body).join("\n"),
      /^Page \d+ of \d+$/m,
      `${file} leaked page furniture`
    );

    titleSets[file] = new Set(articles.map((article) => normalizeTitle(article.title)));
    console.log(`PASS  ${file} (${DOCUMENTS} documents, combined ${format}${hasBibliography ? " with embedded bibliography (citations not extracted, see comment)" : ""})`);
  });
}

// -------------------------------------------------------- cross-matrix identity
// All eight fixtures are the same 100 articles, exported every way the matrix
// allows. If any reader disagrees on the title set, it -- not the fixture --
// is wrong.
const files = Object.keys(titleSets);
if (files.length > 1) {
  const [firstFile, ...rest] = files;
  const base = titleSets[firstFile];
  for (const file of rest) {
    const onlyBase = [...base].filter((title) => !titleSets[file].has(title));
    const onlyOther = [...titleSets[file]].filter((title) => !base.has(title));
    assert.deepEqual(onlyBase, [], `titles only in ${firstFile}, missing from ${file}: ${JSON.stringify(onlyBase.slice(0, 5))}`);
    assert.deepEqual(onlyOther, [], `titles only in ${file}, missing from ${firstFile}: ${JSON.stringify(onlyOther.slice(0, 5))}`);
  }
  console.log(`PASS  cross-matrix identity (${files.length} export variants agree on all 100 titles)`);
  results.ran += 1;
}

console.log(`\n${results.ran} delivery check(s) verified, ${results.skipped} skipped.`);
