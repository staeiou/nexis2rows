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

// Invariants every export must satisfy, checked against all articles at once so
// a broken fixture reports every offending row -- verbatim, with the PDF page it
// came from -- instead of dying on the first assert with nothing to look at.
const INVARIANTS = [
  ["blank publication", (a) => !a.publication],
  ["blank publication_date", (a) => !a.publication_date],
  ["date parsed as publication", (a) => DATE_START_RE.test(a.publication)],
  ["blank body", (a) => !a.body],
  ["body ran past End of Document", (a) => /End of Document/.test(a.body)],
  ["body contains its Load-Date line", (a) => /^Load-Date:/m.test(a.body)]
];

const DATE_START_RE = /^(January|February|March|April|May|June|July|August|September|October|November|December)\b/;

const REPORT_FIELDS = [
  "title", "publication", "publication_date", "section", "length",
  "byline", "dateline", "load_date", "nexis_link"
];

function checkInvariants(articles, file) {
  const failures = [];
  for (const article of articles) {
    for (const [label, isBroken] of INVARIANTS) {
      if (isBroken(article)) failures.push({ label, article });
    }
  }
  if (!failures.length) return;

  const lines = [`\n${failures.length} invariant violation(s) in ${file}:`];
  for (const { label, article } of failures) {
    lines.push(`\n##### ${label}  |  article ${article.source_article_ordinal}  |  PDF page ${article.source_page}`);
    for (const field of REPORT_FIELDS) lines.push(`  ${field} = ${JSON.stringify(article[field])}`);
    lines.push(`  body[0:200] = ${JSON.stringify((article.body || "").slice(0, 200))}`);
  }
  console.log(lines.join("\n"));
  assert.fail(`${failures.length} invariant violation(s) in ${file} (details above)`);
}

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
  },
  {
    // Historical exports. Pre-1930 sources print dates and mastheads in formats
    // the modern-export logic was never exercised against.
    file: "500-presidential-pre-1916.PDF",
    check(articles) {
      assert.equal(articles.length, 500);
      checkInvariants(articles, "500-presidential-pre-1916.PDF");

      // These carry no "Copyright <year>" line, which used to blank the
      // masthead for all 500. The anchor falls back to the "Length:" line.
      const wilson = articles.find((article) => article.source_page === 152);
      assert.ok(wilson, "expected the article starting on PDF page 152");
      assert.equal(wilson.publication, "Primary Sources in U.S. Presidential History");
      assert.equal(wilson.publication_date, "October 7, 1915");
      assert.equal(wilson.byline, "Woodrow Wilson");
      assert.equal(wilson.length, "538 words");
      // The bibliographic block sits below "Body" here and must not be body text.
      assert.ok(wilson.body.startsWith("[Page 8076]"), `body began: ${JSON.stringify(wilson.body.slice(0, 80))}`);
      for (const article of articles) {
        assert.doesNotMatch(
          article.body,
          /^(Document Type|Subject Descriptors|Author Note|Content Note|Availability):/m,
          `article ${article.source_article_ordinal} (PDF page ${article.source_page}) kept metadata in its body`
        );
      }
    }
  },
  {
    // Court opinions: a different document type entirely. This export used to
    // produce zero rows, because article detection required a "Body" line.
    file: "250-cases-pre-1930.PDF",
    check(articles) {
      assert.equal(articles.length, 250);
      checkInvariants(articles, "250-cases-pre-1930.PDF");

      for (const article of articles) {
        assert.equal(article.document_type, "case");
        assert.ok(article.citation, `article ${article.source_article_ordinal} has no citation`);
        assert.ok(article.opinion_by, `article ${article.source_article_ordinal} has no opinion_by`);
      }

      const yickWo = articles.find((article) => article.source_page === 17);
      assert.ok(yickWo, "expected the case starting on PDF page 17");
      assert.equal(yickWo.title, "Yick Wo v. Hopkins");
      assert.equal(yickWo.publication, "Supreme Court of the United States");
      assert.equal(yickWo.publication_date, "Submitted April 14, 1886. ; May 10, 1886, Decided");
      assert.equal(yickWo.docket, "No Number in Original");
      assert.equal(yickWo.citation, "118 U.S. 356 *; 6 S. Ct. 1064 **; 30 L. Ed. 220 ***; 1886 U.S. LEXIS 1938 ****");
      assert.equal(yickWo.caption, "YICK WO v. HOPKINS, SHERIFF.; WO LEE v. HOPKINS, SHERIFF.");
      assert.equal(yickWo.opinion_by, "MATTHEWS");
      assert.match(yickWo.core_terms, /equal protection of the law/);

      // Folsom v. Marsh (1841) dates by court term -- "October, 1841, Term" --
      // with no day, and its court is a circuit court rather than the Supreme
      // Court. Both broke the first version of the header rule.
      const folsom = articles.find((article) => article.title === "Folsom v. Marsh");
      assert.ok(folsom, "expected Folsom v. Marsh");
      assert.equal(folsom.publication, "Circuit Court, D. Massachusetts");
      assert.equal(folsom.publication_date, "October, 1841, Term");

      // Dissents are a separate column, not silently folded into the opinion.
      const withDissent = articles.filter((article) => article.dissent);
      assert.equal(withDissent.length, 85);
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
    // pdf.js ships standard_fonts as .pfb but asks for .ttf, so it warns once per
    // font per file. Text extraction does not use glyph data, so the warnings are
    // noise that buries real output; ERRORS-only keeps genuine failures visible.
    standardFontDataUrl: new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS
  }).promise;

  const pages = await readPages(pdf);
  return parseNexisPdfText(pages.map((page) => page.text).join("\n\f\n"), { pdfName }, pages);
}
