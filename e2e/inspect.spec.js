import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Not a test of the app so much as a way to run real PDFs through it. Point
// INSPECT_PDF at one or more files and the app's own CSV export lands in tmp/,
// so what you inspect is exactly what a user would download -- no parallel
// parsing path that can drift from the shipped one.
//
//   INSPECT_PDF=tmp/foo.PDF npx playwright test e2e/inspect.spec.js
//
// Skipped entirely when INSPECT_PDF is unset, so it costs nothing in CI.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targets = (process.env.INSPECT_PDF || "").split(",").map((entry) => entry.trim()).filter(Boolean);

test.describe("inspect", () => {
  test.skip(targets.length === 0, "set INSPECT_PDF to a comma-separated list of PDF paths");
  test.setTimeout(900_000);

  for (const target of targets) {
    test(`import ${target}`, async ({ page }) => {
      const file = path.resolve(repoRoot, target);
      const consoleMessages = [];
      page.on("console", (message) => consoleMessages.push(`[${message.type()}] ${message.text()}`));
      page.on("pageerror", (error) => consoleMessages.push(`[pageerror] ${String(error)}`));

      await page.goto("");
      await page.locator("#fileInput").setInputFiles(file);
      await page.locator("#importPending").click();

      // Poll the app's own progress bar rather than blocking on one long
      // expect(). A long import and a hung import look identical from the
      // outside, so print progress as it moves and fail fast when it stops.
      const started = Date.now();
      let lastPercent = "";
      let lastChange = Date.now();
      for (;;) {
        if (await page.locator("#downloadCsv").isEnabled()) break;

        const percent = await page.locator("#progressPercent").textContent().catch(() => "");
        const label = await page.locator("#progressLabel").textContent().catch(() => "");
        if (percent !== lastPercent) {
          lastPercent = percent;
          lastChange = Date.now();
          console.log(`  ${Math.round((Date.now() - started) / 1000)}s  ${label} ${percent}`);
        } else if (Date.now() - lastChange > 120_000) {
          const log = await page.locator("#log").innerText().catch(() => "(no log)");
          throw new Error(`stalled at "${label} ${percent}" for 120s\n--- app log ---\n${log}\n--- console ---\n${consoleMessages.join("\n")}`);
        }
        await page.waitForTimeout(2000);
      }

      await expect(page.locator("#pendingPanel")).toBeHidden();
      const articles = await page.locator("#articleCount").textContent();
      console.log(`  done in ${Math.round((Date.now() - started) / 1000)}s: ${articles} articles`);

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator("#downloadCsv").click()
      ]);

      const out = path.join(repoRoot, "tmp", `${path.basename(file).replace(/\.pdf$/i, "")}.csv`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(await download.path(), out);

      const log = await page.locator("#log").innerText().catch(() => "");
      fs.writeFileSync(
        `${out}.log.txt`,
        [`articles: ${articles}`, "", "--- app log ---", log, "", "--- console ---", ...consoleMessages].join("\n")
      );

      console.log(`${target}: ${articles} articles -> ${path.relative(repoRoot, out)}`);
    });
  }
});
