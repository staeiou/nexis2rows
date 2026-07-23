# nexis2rows

Turn Nexis Uni exports into a SQLite database, an Excel workbook, or a CSV —
one row per article. PDF or DOCX, a single file or a ZIP, with or without the
bibliography.

**Everything runs in your browser.** Your files are never uploaded: they are read,
parsed, and converted locally, and the export is handed straight back to you as a
file download. There is no server, no account, and no telemetry. After the first
visit a service worker caches the app so it works offline.

## Use it

Hosted: <https://stuartgeiger.com/nexis2rows>

Or run it locally — see [Development](#development).

### Getting an export out of Nexis Uni

1. Run your search in Nexis Uni.
2. Select the documents you want, then **Download**.
3. **For best results, choose: full documents, include bibliography, file type
   DOCX, and save as individual files (`.ZIP`).** Every other combination works
   too — this one just carries the most structure:
   - **PDF or DOCX**
   - **Separate documents in one file** (a single combined export) or
     **each document in its own file** (a ZIP)
   - **Include bibliography** on or off
4. Drop the result onto nexis2rows. Each `.zip` stays as one pending import you
   can reorder before importing.

**Prefer DOCX if you have the choice.** A PDF repeats a `Page N of M` running
head on every continuation page, which has to be detected and stripped; DOCX
carries none of that furniture, keeps paragraphs whole instead of hard-wrapping
them at the page width, and marks each title with a real heading style. Across
the same 250 documents exported both ways, the two agree on every title and
differ in body text only by that furniture.

**"Include bibliography" is safe to leave on** — but what it does depends on
packaging. A ZIP of individually exported files always carries a manifest
(search provenance and a numbered title list), with or without this toggle;
turning it on adds a second file with the actual citations, one per document.
Neither holds articles, and both are recognised by content rather than
filename. They are not parsed into rows; instead the manifest supplies
`search_terms`, `job_number`, `delivery_date`, and `search_type` for exports
that would otherwise lack them, and the import log reports how many of the
documents it lists were actually parsed — regardless of whether the citations
file is also present.

A single combined file is different: there is no second file to add, so
"include bibliography" instead prepends every citation and the title list
directly into the same file, ahead of the articles. **nexis2rows does not
currently extract that block** — the articles themselves still parse
correctly, but the citations and the "documents listed" check are silently
unavailable in that combination. If you want that check, export as individual
files rather than one combined file.

Nexis caps a single download at 500 documents, so a large corpus arrives as
several files. Import them together — ordering is preserved, and identical files
are detected by hash and skipped rather than double-counted.

## Output

Three exports. They do **not** carry identical columns:

| File | Columns |
| --- | --- |
| `nexis2rows.sqlite` | Every column below, including `raw_text`. `articles` table, indexed on `job_number`, `publication_date`, `title` |
| `nexis2rows.csv` | A leading `row` number, then every column **except `raw_text`**. UTF-8 |
| `nexis2rows.xlsx` | Same as CSV, plus `body.continued.1`, `body.continued.2`, … when a body exceeds Excel's ~32k-character cell limit |

`raw_text` is omitted from CSV and Excel because it roughly doubles file size and
duplicates `body`. **If you want the auditable source text, export SQLite.**

### Columns

| Column | What it holds |
| --- | --- |
| `source_archive` | ZIP filename, if the file came from a ZIP |
| `source_pdf` | Source filename (PDF or DOCX) |
| `source_sha256` | Hash of the source file — identifies duplicate imports |
| `nexis_link` | Canonical `advance.lexis.com` permalink for the article |
| `source_article_ordinal` | 1-based position of the article within its source file |
| `source_page` | 1-based page in the source PDF where the article starts — open that page to check any row against its source. DOCX has no pages, so for DOCX this is the document's position within the file |
| `document_type` | `news` or `case` (see [Document types](#document-types)) |
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

### Document types

Nexis exports more than newspaper articles, and the kinds differ structurally.
`document_type` says which shape a row came from:

- **`news`** — newspapers and wires, plus collections like *Primary Sources in
  U.S. Presidential History*, which carry no copyright line.
- **`case`** — court opinions. `publication` holds the **court**,
  `publication_date` the decision date (often compound, e.g.
  `Submitted April 14, 1886. ; May 10, 1886, Decided`), and `body` the opinion.

Case documents fill these additional columns, which are blank for news rows:

| Column | What it holds |
| --- | --- |
| `citation` | Parallel citations, e.g. `118 U.S. 356 *; 6 S. Ct. 1064 **; …` |
| `caption` | Party caption, e.g. `YICK WO v. HOPKINS, SHERIFF.` |
| `docket` | Docket number, or `No Number in Original` |
| `prior_history` / `subsequent_history` | Procedural history |
| `disposition` | Disposition line |
| `core_terms` | Nexis-generated key terms |
| `overview` | Case summary overview |
| `headnotes` | LexisNexis headnotes |
| `syllabus` | Syllabus |
| `counsel` | Counsel of record |
| `judges` | Panel |
| `opinion_by` / `concur_by` / `dissent_by` | Authoring justices |
| `concur` / `dissent` | Concurrence and dissent text (all of them, concatenated) |

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
| `scripts/test-delivery.mjs` | The export matrix — PDF/DOCX × single/ZIP × bibliography, against `fixtures/`'s same 100 documents exported all eight ways — and that all eight agree on every title |
| `e2e/permutations.spec.js` | The same matrix driven through the real app in a browser: staging, the worker, the import log, and the exported columns |
| `scripts/dump-articles.mjs` | Not a test — prints parsed rows verbatim with their PDF page, for checking output against the source by eye |
| `e2e/app.spec.js` | The actual app: upload → parse → filter → download all three formats |

The Playwright suite is what covers the parts Node cannot: PDF parsing happens
in a Web Worker and the SQLite export runs WASM, so only a real browser
exercises them. It needs browsers once:

```sh
npx playwright install chromium
```

The parser fixtures are real Nexis exports, which are copyrighted news content
and therefore **not committed** (`tests/` and `fixtures/` are both gitignored).
Any fixture that is missing is skipped with a notice instead of failing, so
`npm test` passes on a fresh clone — it just verifies less:

```
SKIP  nytimes-2026-07-06.PDF (not present in tests/)
SKIP  nexis-pdf-zip-with-biblio.ZIP (not present in fixtures/)
```

To get real coverage, put your own Nexis exports in `tests/` and add them to the
`FIXTURES` list in `scripts/test-parser.mjs` with assertions about what they
should produce. `e2e/app.spec.js` skips its import tests the same way, and points
at `tests/nytimes-2026-07-06.PDF` by default — change `FIXTURE` and
`FIXTURE_ARTICLES` there to use your own.

The export-matrix suites (`scripts/test-delivery.mjs`,
`e2e/permutations.spec.js`) look in `fixtures/` instead, for the same reason —
the same set of articles exported all eight ways (PDF/DOCX × single file/ZIP ×
bibliography on/off), named `nexis-{pdf,docx}-{singlefile,zip}-{with,without}-biblio`.
Both suites skip whichever combination is absent.

CI (`.github/workflows/ci.yml`) runs both suites on every push and pull request.
Since fixtures are not in the repo, CI verifies the sanitizer, the UI structure,
the empty state, and that every wired-up element exists.

### Layout

```
src/
  main.js            entry point: state, import pipeline, event wiring
  parser.js          Nexis text -> article rows      (see docs/parsing.md)
  delivery.js        Export-matrix routing; bibliography companions
  docx-text.js       DOCX -> page entries (same contract as pdf-text.js)
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
