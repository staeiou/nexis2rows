// The export matrix, driven through the real app in a real browser, against
// fixtures/ -- the same 100 articles exported all eight ways (PDF or DOCX,
// single file or a ZIP of individual files, with or without the bibliography).
//
// Two things this fixture set corrected versus an earlier, synthetic version
// of this suite (see scripts/test-delivery.mjs for the Node-level detail):
//
//   - A ZIP "without bibliography" still ships the doclist (delivery header +
//     numbered title list) -- only the separate citations file is missing.
//     Provenance (search_terms, job_number) is still restored; only the
//     "N citations" log line and the extra citation count are absent.
//   - A combined single-file export "with bibliography" does NOT get a
//     separate companion the way a ZIP does. Nexis prepends all 100 citations,
//     each under its own "Bibliography" heading, ahead of the articles, inside
//     the same file. The app does not extract that block today -- it is
//     discarded along with the rest of the header -- so those tests only
//     confirm the articles parse cleanly and nothing leaks into a body.
//
// No fixtures are derived or synthesized here: every file handed to the app is
// byte-identical to what Nexis produced. The only extraction is pulling a
// single real document out of a ZIP (for the "bare file" and "mixed" cases),
// done in memory via JSZip, not written back to disk.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturesDir = path.join(repoRoot, "fixtures");

const FIXTURES = {
  pdfZipWith: path.join(fixturesDir, "nexis-pdf-zip-with-biblio.ZIP"),
  pdfZipWithout: path.join(fixturesDir, "nexis-pdf-zip-without-biblio.ZIP"),
  pdfSingleWith: path.join(fixturesDir, "nexis-pdf-singlefile-with-biblio.PDF"),
  pdfSingleWithout: path.join(fixturesDir, "nexis-pdf-singlefile-without-biblio.PDF"),
  docxZipWith: path.join(fixturesDir, "nexis-docx-zip-with-biblio.ZIP"),
  docxZipWithout: path.join(fixturesDir, "nexis-docx-zip-without-biblio.ZIP"),
  docxSingleWith: path.join(fixturesDir, "nexis-docx-singlefile-with-biblio.docx"),
  docxSingleWithout: path.join(fixturesDir, "nexis-docx-singlefile-without-biblio.docx")
};
const DOCUMENTS = 100;
const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

const hasFixtures = Object.values(FIXTURES).every((file) => fs.existsSync(file));

// The doclist and citations companions, whatever they are named -- classified
// by content everywhere else in this app, but here we only need to skip them
// when picking a document to extract.
const isCompanionName = (name) => /_doclist/i.test(name) || /^Bibliography\./i.test(name);

async function firstDocument(zipPath, format) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(zipPath));
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && !isCompanionName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const buffer = Buffer.from(await entries[0].async("nodebuffer"));
  return { name: entries[0].name, mimeType: MIME[format], buffer };
}

// Minimal RFC 4180 reader, only for asserting on exported columns. Bodies
// contain commas, quotes, and newlines, so splitting on "," would not do.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function downloadCsv(page) {
  const [downloaded] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#downloadCsv").click()
  ]);
  const text = await fs.promises.readFile(await downloaded.path(), "utf8");
  const [header, ...rows] = parseCsv(text);
  return { header, rows, column: (name) => header.indexOf(name) };
}

// Stage, import, and wait for the expected row count. `files` may be paths or
// Playwright FilePayload objects ({ name, mimeType, buffer }) -- setInputFiles
// accepts either.
async function importFiles(page, files, expectedRows) {
  await page.goto("");
  await page.locator("#fileInput").setInputFiles(files);
  await expect(page.locator("#pendingPanel")).toBeVisible();
  await page.locator("#importPending").click();
  await expect(page.locator("#articleCount")).toHaveText(String(expectedRows), { timeout: 300_000 });
}

test.describe("export matrix", () => {
  test.skip(!hasFixtures, "the fixtures/ export matrix is not present");

  // ------------------------------------------------------------ one bare file
  for (const format of ["pdf", "docx"]) {
    test(`a single ${format.toUpperCase()} document imports on its own`, async ({ page }) => {
      const doc = await firstDocument(FIXTURES[`${format}ZipWithout`], format);
      await importFiles(page, [doc], 1);

      await expect(page.locator(".pending-row")).toHaveCount(0);
      await expect(page.locator("#fileCount")).toHaveText("1");

      const row = page.locator("#articleRows tr").first();
      await expect(row.locator("td").nth(1)).not.toBeEmpty(); // title
      await expect(row.locator("td").nth(2)).not.toBeEmpty(); // date
      await expect(row.locator("td").nth(6)).not.toBeEmpty(); // body preview
    });
  }

  // ------------------------------------------------------- ZIP, both bibliography states
  for (const format of ["pdf", "docx"]) {
    test(`a ZIP of individual ${format.toUpperCase()} files without the bibliography still restores provenance via the doclist`, async ({ page }) => {
      await importFiles(page, [FIXTURES[`${format}ZipWithout`]], DOCUMENTS);

      await expect(page.locator(".log-row")).toHaveCount(1);
      await expect(page.locator("#fileCount")).toHaveText("1");
      await expect(page.locator(".log-row.error")).toHaveCount(0);
      const log = page.locator(".log");
      await expect(log).toContainText(`Bibliography: ${DOCUMENTS} documents listed`);
      await expect(log).not.toContainText("citations");

      // The doclist restores provenance even without the citations file.
      const csv = await downloadCsv(page);
      expect(csv.rows).toHaveLength(DOCUMENTS);
      for (const row of csv.rows) {
        expect(row[csv.column("search_terms")]).toBe("the");
        expect(row[csv.column("job_number")]).not.toBe("");
      }
    });

    test(`a ZIP of individual ${format.toUpperCase()} files with the bibliography restores provenance and citations`, async ({ page }) => {
      await importFiles(page, [FIXTURES[`${format}ZipWith`]], DOCUMENTS);

      await expect(page.locator(".log-row")).toHaveCount(1);
      await expect(page.locator("#fileCount")).toHaveText("1");
      await expect(page.locator(".log-row.error")).toHaveCount(0);
      await expect(page.locator(".log-row.warn")).toHaveCount(0);
      const log = page.locator(".log");
      await expect(log).toContainText(`Bibliography: ${DOCUMENTS} documents listed`);
      await expect(log).toContainText(`Bibliography: ${DOCUMENTS} citations`);
      await expect(log).toContainText(`${DOCUMENTS} of ${DOCUMENTS} listed documents parsed`);

      const csv = await downloadCsv(page);
      expect(csv.rows).toHaveLength(DOCUMENTS);
      for (const row of csv.rows) {
        expect(row[csv.column("search_terms")]).toBe("the");
        expect(row[csv.column("job_number")]).not.toBe("");
      }
    });
  }

  // ------------------------------------------------------------- combined single file
  for (const format of ["pdf", "docx"]) {
    test(`a combined ${format.toUpperCase()} export splits into one row per document`, async ({ page }) => {
      await importFiles(page, [FIXTURES[`${format}SingleWithout`]], DOCUMENTS);
      await expect(page.locator("#fileCount")).toHaveText("1");

      // A combined export carries its own delivery header, so no doclist is
      // needed -- and that header must not be mistaken for the first document.
      const csv = await downloadCsv(page);
      expect(csv.rows).toHaveLength(DOCUMENTS);
      for (const row of csv.rows) {
        expect(row[csv.column("search_terms")].toLowerCase()).toBe("the");
        expect(row[csv.column("title")]).not.toMatch(/^User Name:/);
        expect(row[csv.column("title")]).not.toBe("");
        expect(row[csv.column("publication")]).not.toBe("");
      }
    });

    test(`a combined ${format.toUpperCase()} export with an embedded bibliography still parses every document`, async ({ page }) => {
      await importFiles(page, [FIXTURES[`${format}SingleWith`]], DOCUMENTS);
      await expect(page.locator("#fileCount")).toHaveText("1");

      const csv = await downloadCsv(page);
      expect(csv.rows).toHaveLength(DOCUMENTS);
      for (const row of csv.rows) {
        expect(row[csv.column("search_terms")].toLowerCase()).toBe("the");
        expect(row[csv.column("title")]).not.toBe("");
        expect(row[csv.column("body")]).not.toMatch(/^Bibliography$/m);
      }
    });
  }

  // -------------------------------------------------------------------- mixed
  test("PDF and DOCX imported together land in one table", async ({ page }) => {
    const [pdfDoc, docxDoc] = await Promise.all([
      firstDocument(FIXTURES.pdfZipWithout, "pdf"),
      firstDocument(FIXTURES.docxZipWithout, "docx")
    ]);
    await importFiles(page, [pdfDoc, docxDoc], 2);

    await expect(page.locator("#fileCount")).toHaveText("2");
    const csv = await downloadCsv(page);
    expect(csv.rows).toHaveLength(2);
    // The same document exported in both formats: the readers must agree on it.
    const titles = csv.rows.map((row) => row[csv.column("title")]);
    expect(titles[0]).toBe(titles[1]);
  });
});
