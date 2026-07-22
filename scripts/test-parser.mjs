// Parser regression tests against real Nexis Uni exports.
//
// The fixture PDFs are copyrighted news content and are deliberately NOT in the
// repository (tests/ is gitignored). Any fixture that is absent is skipped with
// a notice rather than failing, so `npm test` still passes on a fresh clone --
// it just verifies less. To get full coverage, drop the named PDFs into tests/.
//
// Text extraction comes from src/pdf-text.js, the same code the app uses, so a
// passing test means the app would see identical text.

import assert from "node:assert/strict";
import fs from "node:fs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseNexisPdfText } from "../src/parser.js";
import { readPages } from "../src/pdf-text.js";

const FIXTURES = [
  {
    file: "nytimes-2026-07-06.PDF",
    // Single-publication export: every article is The New York Times.
    check(articles) {
      assert.equal(articles.length, 139);

      const publications = new Set(articles.map((article) => article.publication));
      assert.deepEqual([...publications], ["The New York Times"]);

      // Every article must resolve both fields; a blank or a date landing in
      // `publication` is the regression this fixture exists to catch.
      for (const article of articles) {
        assert.ok(article.publication, `article ${article.source_article_ordinal} has no publication`);
        assert.ok(article.publication_date, `article ${article.source_article_ordinal} has no publication_date`);
        assert.doesNotMatch(
          article.publication,
          /^(January|February|March|April|May|June|July|August|September|October|November|December)\b/,
          `article ${article.source_article_ordinal} parsed a date as its publication`
        );
      }

      // The body ends at Load-Date / End of Document, never swallowing either.
      for (const article of articles) {
        assert.doesNotMatch(article.body, /End of Document/, `article ${article.source_article_ordinal} body ran past End of Document`);
        assert.doesNotMatch(article.body, /^Load-Date:/m, `article ${article.source_article_ordinal} body contains its Load-Date line`);
      }
    }
  },
  {
    file: "random500the.PDF",
    // Mixed-source export: ~156 publications, and the awkward layouts --
    // "Copyright (c) <year>", month-only dates, aggregator wrapper lines.
    check(articles) {
      assert.equal(articles.length, 500);

      const publications = new Set(articles.map((article) => article.publication));
      assert.ok(publications.size > 100, `expected many publications, got ${publications.size}`);

      for (const article of articles) {
        assert.ok(article.publication, `article ${article.source_article_ordinal} has no publication`);
        assert.ok(article.body, `article ${article.source_article_ordinal} has no body`);
      }

      // "Copyright (c) 2026 Tortoise Media" -- the (c) glyph used to break the
      // copyright anchor entirely, blanking publication and publication_date.
      const observer = articles.find((article) => article.publication === "The Observer - London (Print)");
      assert.ok(observer, "expected an article published by The Observer - London (Print)");
      assert.equal(observer.publication_date, "July 19, 2026");

      // A month-and-year date with no day still anchors correctly.
      const abc = articles.find((article) => article.publication === "ABC Regional News (Australia)");
      assert.ok(abc, "expected an article published by ABC Regional News (Australia)");
      assert.equal(abc.publication_date, "July 2026");
    }
  }
];

let ran = 0;
let skipped = 0;

for (const fixture of FIXTURES) {
  const path = new URL(`../tests/${fixture.file}`, import.meta.url);

  if (!fs.existsSync(path)) {
    console.log(`SKIP  ${fixture.file} (not present in tests/)`);
    skipped += 1;
    continue;
  }

  const articles = await parseFixture(path, fixture.file);
  fixture.check(articles);
  console.log(`PASS  ${fixture.file} (${articles.length} articles)`);
  ran += 1;
}

console.log(`\n${ran} fixture(s) verified, ${skipped} skipped.`);
if (ran === 0) {
  console.log("No fixture PDFs found. Add Nexis exports to tests/ for real coverage.");
}

async function parseFixture(path, pdfName) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(fs.readFileSync(path)),
    disableWorker: true,
    standardFontDataUrl: new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href
  }).promise;

  const pages = await readPages(pdf);
  return parseNexisPdfText(pages.map((page) => page.text).join("\n\f\n"), { pdfName }, pages);
}
