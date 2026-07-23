// Column count of the articles table. Shared with src/ui/render.js so the
// "no rows" placeholder colspan cannot drift out of sync with the header again.
export const ARTICLE_TABLE_COLUMNS = 7;

// The whole app shell. Kept as one template string rather than built up with
// DOM calls: the markup is static, and having it in one readable block makes the
// element ids that src/ui/elements.js looks up easy to find.
export const APP_HTML = `
  <main class="shell">
    <section class="workspace">
      <header class="topbar">
        <div>
          <div class="title-menu">
            <button id="titleMenuToggle" class="title-menu-toggle" type="button" aria-haspopup="true" aria-expanded="false">
              <h1>nexis2rows</h1>
              <svg class="title-menu-caret" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2 4l5 6 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <div id="titleMenu" class="title-menu-panel" hidden></div>
          </div>
          <p>Convert Nexis Uni exports into local tabular files. PDF or DOCX, a single file or a ZIP, with or without the bibliography. Runs 100% locally inside your browser, we never see your files.</p>
        </div>
        <div class="actions">
          <button id="downloadSqlite" class="primary" disabled>Download SQLite</button>
          <button id="downloadExcel" disabled>Download Excel</button>
          <button id="downloadCsv" disabled>Download CSV</button>
        </div>
      </header>

      <label id="dropzone" class="dropzone">
        <input id="fileInput" type="file" accept=".zip,.pdf,.docx,application/pdf,application/zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple />
        <span class="drop-title">Drop Nexis Uni PDFs, DOCX files, or ZIPs</span>
        <span class="drop-subtitle">Any Nexis export: PDF or DOCX, bare or zipped. You can re-order and remove files after.</span>
      </label>

      <p class="export-tip">
        <strong>For best results</strong>, download from Nexis with:
        <strong>full documents</strong>, <strong>include bibliography</strong>,
        file type <strong>DOCX</strong>, and
        <strong>save as individual files (.ZIP)</strong>.
        Other combinations all work &mdash; this one just carries the most structure.
      </p>

      <section id="pendingPanel" class="panel pending-panel" hidden>
        <div class="panel-head">
          <h2>Pending files</h2>
          <div class="pending-actions">
            <button id="clearPending" class="ghost" disabled>Clear pending</button>
            <button id="importPending" class="primary" disabled>Import in this order</button>
          </div>
        </div>
        <div id="pendingList" class="pending-list"></div>
      </section>

      <section id="progressPanel" class="progress-panel" aria-live="polite" hidden>
        <div class="progress-head">
          <strong id="progressLabel">Working</strong>
          <span id="progressPercent">0%</span>
        </div>
        <div class="progress-track">
          <div id="progressFill" class="progress-fill"></div>
        </div>
      </section>

      <section class="status-grid">
        <div>
          <span class="metric" id="articleCount">0</span>
          <span class="label">articles</span>
        </div>
        <div>
          <span class="metric" id="fileCount">0</span>
          <span class="label">Files parsed</span>
        </div>
        <div>
          <span class="metric" id="jobCount">0</span>
          <span class="label">jobs</span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Imports</h2>
          <button id="clearAll" class="ghost" disabled>Clear</button>
        </div>
        <div id="log" class="log empty">No files imported yet.</div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Articles</h2>
          <input id="filterInput" type="search" placeholder="Filter title, publication, date, section, byline, dateline, body" disabled />
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Date</th>
                <th>Section</th>
                <th>Byline</th>
                <th>Dateline</th>
                <th>Text</th>
              </tr>
            </thead>
            <tbody id="articleRows">
              <tr><td colspan="${ARTICLE_TABLE_COLUMNS}" class="muted">Import files to populate rows.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  </main>
`;
