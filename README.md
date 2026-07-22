# nexis2rows

Turn Nexis Uni PDF exports into a SQLite database, an Excel workbook, or a CSV —
one row per article.

**Everything runs in your browser.** Your PDFs are never uploaded: they are read,
parsed, and converted locally, and the export is handed straight back to you as a
file download. There is no server, no account, and no telemetry. After the first
visit a service worker caches the app so it works offline.

## Use it

Hosted: <https://stuartgeiger.com/nexis2rows>

Or run it locally — see [Development](#development).

### Getting a PDF out of Nexis Uni

1. Run your search in Nexis Uni.
2. Select the documents you want, then **Download**.
3. Choose PDF as the format, and keep the default of **separate documents in one
   file**. nexis2rows splits articles on the `End of Document` marker Nexis puts
   between them.
4. Drop the resulting `.pdf` onto nexis2rows. A `.zip` of such PDFs works too; it
   is expanded into a pending list you can reorder before importing.

Nexis caps a single download at 500 documents, so a large corpus arrives as
several PDFs. Import them together — ordering is preserved, and identical PDFs
are detected by hash and skipped rather than double-counted.

## Output

Three exports. They do **not** carry identical columns:

| File | Columns |
| --- | --- |
| `nexis2rows.sqlite` | All 20 columns below, including `raw_text`. `articles` table, indexed on `job_number`, `publication_date`, `title` |
| `nexis2rows.csv` | A leading `row` number, then every column **except `raw_text`**. UTF-8 |
| `nexis2rows.xlsx` | Same as CSV, plus `body.continued.1`, `body.continued.2`, … when a body exceeds Excel's ~32k-character cell limit |

`raw_text` is omitted from CSV and Excel because it roughly doubles file size and
duplicates `body`. **If you want the auditable source text, export SQLite.**

### Columns

| Column | What it holds |
| --- | --- |
| `source_archive` | ZIP filename, if the PDF came from a ZIP |
| `source_pdf` | PDF filename |
| `source_sha256` | Hash of the source PDF — identifies duplicate imports |
| `nexis_link` | Canonical `advance.lexis.com` permalink for the article |
| `source_article_ordinal` | 1-based position of the article within its PDF |
| `delivery_date` | "Date and Time" from the Nexis delivery cover page |
| `job_number` | Nexis job number from the cover page |
| `search_terms` | The search that produced the export |
| `search_type` | Nexis search type (e.g. Natural Language, Boolean) |
| `title` | Article headline |
| `publication` | Publication name, e.g. `The New York Times` |
| `publication_date` | Date line as printed, e.g. `July 20, 2026 Monday 13:51 EST` |
| `section` | Nexis `Section:` field |
| `length` | Nexis `Length:` field, e.g. `456 words` |
| `byline` | Nexis `Byline:` field |
| `dateline` | Nexis `Dateline:` field |
| `load_date` | Nexis `Load-Date:` field |
| `body` | Full article text |
| `body_sha256` | Hash of `body` — for dedup and change detection |
| `raw_text` | Unparsed text of the article's pages, for auditing |

`section`, `byline`, and `dateline` are blank whenever Nexis did not print them,
which is common: in one 500-article mixed-source export, only 125 articles
carried a `Section:` and 121 a `Byline:`. Blank means absent in the source, not a
parse failure — `raw_text` lets you confirm that for any row.

For how each field is located in the PDF, and the source quirks worth knowing
before you analyze this data, see **[docs/parsing.md](docs/parsing.md)**.

## Development

```sh
npm install
npm run dev      # http://127.0.0.1:3000
npm run build    # production build into dist/
npm run preview  # serve the production build
npm test
```

### Tests

```sh
npm test          # fast Node suites
npm run test:e2e  # Playwright, drives a real browser against a real build
npm run test:all  # both
```

| Script | Covers |
| --- | --- |
| `scripts/test-xml-sanitize.mjs` | Stripping XML-illegal characters that corrupt `.xlsx` |
| `scripts/test-ui.mjs` | UI structure — every queried element id exists in the markup |
| `scripts/test-parser.mjs` | Parsing real Nexis PDFs, asserting counts and specific rows |
| `e2e/app.spec.js` | The actual app: upload → parse → filter → download all three formats |

The Playwright suite is what covers the parts Node cannot: PDF parsing happens
in a Web Worker and the SQLite export runs WASM, so only a real browser
exercises them. It needs browsers once:

```sh
npx playwright install chromium
```

The parser fixtures are real Nexis exports, which are copyrighted news content
and therefore **not committed** (`tests/` is gitignored). Any fixture that is
missing is skipped with a notice instead of failing, so `npm test` passes on a
fresh clone — it just verifies less:

```
SKIP  nytimes-2026-07-06.PDF (not present in tests/)
```

To get real coverage, put your own Nexis exports in `tests/` and add them to the
`FIXTURES` list in `scripts/test-parser.mjs` with assertions about what they
should produce. `e2e/app.spec.js` skips its import tests the same way, and points
at `tests/nytimes-2026-07-06.PDF` by default — change `FIXTURE` and
`FIXTURE_ARTICLES` there to use your own.

CI (`.github/workflows/ci.yml`) runs both suites on every push and pull request.
Since fixtures are not in the repo, CI verifies the sanitizer, the UI structure,
the empty state, and that every wired-up element exists.

### Layout

```
src/
  main.js            entry point: state, import pipeline, event wiring
  parser.js          Nexis PDF text -> article rows  (see docs/parsing.md)
  pdf.js             pdf.js setup + Web Worker
  pdf-text.js        page -> text, shared by the app and the tests
  database.js        SQLite / XLSX / CSV export
  hash.js            SHA-256 with a non-secure-context fallback
  download.js        Blob download helper
  polyfills.js       Safari < 17.4 shims (see docs/safari-http-notes.md)
  ui/
    template.js      app markup
    elements.js      mounts the markup, returns the element map
    render.js        all DOM writing
    format.js        escapeHtml / previewText / describeError
    family-menu.js   links to sibling tools
```

### Deployment

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. `vite.config.js` sets `base: '/nexis2rows/'`;
change it if you host at a different path.

## Browser support

Current Chrome, Firefox, Safari, and Edge. Safari 17.2 and other pre-17.4 builds
need the polyfills in `src/polyfills.js`, and serving over plain `http://` rather
than HTTPS disables service workers and `crypto.subtle` entirely. Both cases, and
the fallbacks for them, are documented in
[docs/safari-http-notes.md](docs/safari-http-notes.md).

## License

MIT — see [LICENSE](LICENSE).
