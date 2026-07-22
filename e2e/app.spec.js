import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Real Nexis exports are copyrighted and gitignored (see tests/ and the README).
// Tests needing one skip when it is absent, matching scripts/test-parser.mjs.
const FIXTURE = path.join(repoRoot, "tests", "nytimes-2026-07-06.PDF");
const FIXTURE_ARTICLES = 139;
const hasFixture = fs.existsSync(FIXTURE);

test.describe("empty state", () => {
  test("loads with exports disabled and a placeholder row", async ({ page }) => {
    await page.goto("");

    await expect(page.locator("h1")).toHaveText("nexis2rows");
    await expect(page.locator("#articleCount")).toHaveText("0");
    await expect(page.locator("#fileCount")).toHaveText("0");

    for (const id of ["#downloadSqlite", "#downloadExcel", "#downloadCsv"]) {
      await expect(page.locator(id)).toBeDisabled();
    }
    await expect(page.locator("#filterInput")).toBeDisabled();
    await expect(page.locator("#pendingPanel")).toBeHidden();
    await expect(page.locator("#articleRows")).toContainText("Import files to populate rows.");
  });

  test("every element the app wires up exists in the DOM", async ({ page }) => {
    await page.goto("");

    const source = fs.readFileSync(path.join(repoRoot, "src", "ui", "elements.js"), "utf8");
    const ids = [...source.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);

    for (const id of ids) {
      await expect(page.locator(`#${id}`), `#${id} should exist`).toHaveCount(1);
    }
  });
});

test.describe("import and export", () => {
  test.skip(!hasFixture, `fixture not present: ${path.relative(repoRoot, FIXTURE)}`);

  test("parses a Nexis PDF and exports every format", async ({ page }) => {
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    await page.goto("");

    // Staging: the file lands in the pending list, not straight into a parse.
    await page.locator("#fileInput").setInputFiles(FIXTURE);
    await expect(page.locator("#pendingPanel")).toBeVisible();
    await expect(page.locator(".pending-row")).toHaveCount(1);

    await page.locator("#importPending").click();

    await expect(page.locator("#articleCount")).toHaveText(String(FIXTURE_ARTICLES), { timeout: 150_000 });
    await expect(page.locator("#fileCount")).toHaveText("1");
    await expect(page.locator("#pendingPanel")).toBeHidden();

    // The table is populated and the first row carries real parsed values.
    await expect(page.locator("#articleRows tr")).toHaveCount(FIXTURE_ARTICLES);
    const firstRow = page.locator("#articleRows tr").first();
    await expect(firstRow.locator("td").nth(1)).not.toBeEmpty(); // title
    await expect(firstRow.locator("td").nth(2)).not.toBeEmpty(); // date
    await expect(firstRow.locator("td").nth(6)).not.toBeEmpty(); // body preview

    // Filtering narrows the table, and clearing it restores every row.
    await page.locator("#filterInput").fill("zzzznotarealtoken");
    await expect(page.locator("#articleRows")).toContainText("No matching articles.");
    await page.locator("#filterInput").fill("");
    await expect(page.locator("#articleRows tr")).toHaveCount(FIXTURE_ARTICLES);

    // CSV and Excel lead with a row number and drop raw_text; only SQLite
    // carries it. See the export table in the README.
    const csv = await download(page, "#downloadCsv");
    const header = csv.toString("utf8").split("\n")[0];
    expect(header.startsWith("row,")).toBe(true);
    for (const column of ["title", "publication", "publication_date", "body"]) {
      expect(header).toContain(column);
    }
    expect(header).not.toContain("raw_text");
    expect(header).not.toContain("abstract");
    // One header line plus one line per article, ignoring quoted newlines is
    // unsafe, so just assert the file is substantial and well-formed at the top.
    expect(csv.byteLength).toBeGreaterThan(10_000);

    const sqlite = await download(page, "#downloadSqlite");
    expect(sqlite.subarray(0, 15).toString("utf8")).toBe("SQLite format 3");
    // The schema text lives in the file, so this proves raw_text really is kept.
    expect(sqlite.toString("latin1")).toContain("raw_text");

    const xlsx = await download(page, "#downloadExcel");
    expect(xlsx.subarray(0, 2).toString("utf8")).toBe("PK"); // xlsx is a zip
    expect(xlsx.byteLength).toBeGreaterThan(1000);

    expect(consoleErrors, "app logged errors during import").toEqual([]);
  });

  test("re-importing the same PDF is skipped as a duplicate", async ({ page }) => {
    await page.goto("");

    await page.locator("#fileInput").setInputFiles(FIXTURE);
    await page.locator("#importPending").click();
    await expect(page.locator("#articleCount")).toHaveText(String(FIXTURE_ARTICLES), { timeout: 150_000 });

    await page.locator("#fileInput").setInputFiles(FIXTURE);
    await page.locator("#importPending").click();

    await expect(page.locator(".log-row.warn")).toContainText("Skipped duplicate PDF");
    // The duplicate must not double the row count.
    await expect(page.locator("#articleCount")).toHaveText(String(FIXTURE_ARTICLES));
  });
});

async function download(page, selector) {
  const [downloaded] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(selector).click()
  ]);
  return fs.promises.readFile(await downloaded.path());
}
