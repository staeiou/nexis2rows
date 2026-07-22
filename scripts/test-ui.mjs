// Structural checks on the UI modules. These run in Node with no DOM: they
// compare the markup in src/ui/template.js against what src/ui/elements.js and
// src/ui/render.js expect of it, which is where a refactor is most likely to
// break the app silently (a querySelector that now returns null).

import assert from "node:assert/strict";
import fs from "node:fs";
import { APP_HTML, ARTICLE_TABLE_COLUMNS } from "../src/ui/template.js";
import { escapeHtml, previewText, describeError } from "../src/ui/format.js";

const templateIds = new Set([...APP_HTML.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

// Every element mountApp() looks up must exist in the template.
const elementsSource = fs.readFileSync(new URL("../src/ui/elements.js", import.meta.url), "utf8");
const queriedIds = [...elementsSource.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);

assert.ok(queriedIds.length > 15, `expected mountApp to query many ids, found ${queriedIds.length}`);
for (const id of queriedIds) {
  if (id === "app") continue; // the mount point lives in index.html, not the template
  assert.ok(templateIds.has(id), `elements.js queries #${id}, which is not in APP_HTML`);
}

// The "no rows" placeholder colspan must match the real column count, or the
// empty-state row spans the wrong width (this was previously 6 against 7 <th>).
const headerCells = [...APP_HTML.matchAll(/<th>/g)].length;
assert.equal(
  headerCells,
  ARTICLE_TABLE_COLUMNS,
  `template has ${headerCells} <th> but ARTICLE_TABLE_COLUMNS is ${ARTICLE_TABLE_COLUMNS}`
);

const renderSource = fs.readFileSync(new URL("../src/ui/render.js", import.meta.url), "utf8");
assert.doesNotMatch(renderSource, /colspan="\d/, "render.js should use ARTICLE_TABLE_COLUMNS, not a literal colspan");

// Pure helpers.
assert.equal(escapeHtml(`<a href="x">&</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
assert.equal(escapeHtml(null), "");
assert.equal(escapeHtml(undefined), "");

assert.equal(previewText("  spaced   out  "), "spaced out");
assert.equal(previewText(""), "");
const long = "x".repeat(400);
assert.ok(previewText(long).includes("[...]"), "long text should be elided");
assert.ok(previewText(long).length < 250, "elided preview should be short");
assert.equal(previewText("short"), "short");

assert.equal(describeError(null), "Unknown error");
assert.match(describeError(new Error("boom")), /^Error: boom/);

console.log("UI structure tests passed.");
