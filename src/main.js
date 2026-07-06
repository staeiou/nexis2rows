import "./polyfills.js";
import JSZip from "jszip";
import { createDatabase, exportCsv, exportExcel } from "./database.js";
import { extractPdfPages } from "./pdf.js";
import { parseNexisPdfText } from "./parser.js";
import { FAMILY_SITES } from "./family-sites.js";
import "./styles.css";

const CURRENT_SITE_NAME = "nexis2rows";

const state = {
  imports: [],
  articles: [],
  pendingFiles: [],
  busy: false
};
let pendingId = 1;

document.querySelector("#app").innerHTML = `
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
          <p>Convert Nexis Uni PDF exports, whether uploaded as bare PDFs or ZIP files, into local tabular files. Runs 100% locally inside your browser, we never see your files.</p>
        </div>
        <div class="actions">
          <button id="downloadSqlite" class="primary" disabled>Download SQLite</button>
          <button id="downloadExcel" disabled>Download Excel</button>
          <button id="downloadCsv" disabled>Download CSV</button>
        </div>
      </header>

      <label id="dropzone" class="dropzone">
        <input id="fileInput" type="file" accept=".zip,.pdf,application/pdf,application/zip" multiple />
        <span class="drop-title">Drop Nexis Uni PDFs or ZIPs</span>
        <span class="drop-subtitle">Add bare PDFs or ZIPs of PDFs. You can re-order and remove files after.</span>
      </label>

      <section id="pendingPanel" class="panel pending-panel" hidden>
        <div class="panel-head">
          <h2>Pending PDFs</h2>
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
          <span class="label">PDFs parsed</span>
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
          <input id="filterInput" type="search" placeholder="Filter title, byline, date, dateline, body" disabled />
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
              <tr><td colspan="7" class="muted">Import files to populate rows.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  </main>
`;

const fileInput = document.querySelector("#fileInput");
const dropzone = document.querySelector("#dropzone");
const log = document.querySelector("#log");
const filterInput = document.querySelector("#filterInput");
const downloadSqlite = document.querySelector("#downloadSqlite");
const downloadExcel = document.querySelector("#downloadExcel");
const downloadCsv = document.querySelector("#downloadCsv");
const clearAll = document.querySelector("#clearAll");
const pendingPanel = document.querySelector("#pendingPanel");
const pendingList = document.querySelector("#pendingList");
const clearPending = document.querySelector("#clearPending");
const importPending = document.querySelector("#importPending");
const progressPanel = document.querySelector("#progressPanel");
const progressLabel = document.querySelector("#progressLabel");
const progressPercent = document.querySelector("#progressPercent");
const progressFill = document.querySelector("#progressFill");
const titleMenuToggle = document.querySelector("#titleMenuToggle");
const titleMenu = document.querySelector("#titleMenu");

initFamilyMenu();

fileInput.addEventListener("change", () => stageFiles([...fileInput.files]));
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  stageFiles([...event.dataTransfer.files]);
});
filterInput.addEventListener("input", renderArticles);
clearAll.addEventListener("click", () => {
  state.imports = [];
  state.articles = [];
  render();
});
clearPending.addEventListener("click", () => {
  state.pendingFiles = [];
  fileInput.value = "";
  render();
});
importPending.addEventListener("click", () => importPendingFiles());
downloadSqlite.addEventListener("click", async () => {
  setBusy(true, "Building SQLite database...");
  setProgress("Building SQLite database", 15);
  try {
    const bytes = await createDatabase(state.articles);
    setProgress("SQLite database ready", 100);
    downloadBlob(bytes, "nexis2rows.sqlite", "application/vnd.sqlite3");
  } finally {
    setBusy(false);
  }
});
downloadCsv.addEventListener("click", () => {
  setProgress("Preparing CSV export", 100);
  downloadBlob(exportCsv(state.articles), "nexis2rows.csv", "text/csv;charset=utf-8");
  hideProgressSoon();
});
downloadExcel.addEventListener("click", () => {
  setProgress("Preparing Excel export", 25);
  const bytes = exportExcel(state.articles);
  setProgress("Excel workbook ready", 100);
  downloadBlob(
    bytes,
    "nexis2rows.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  hideProgressSoon();
});

if ("serviceWorker" in navigator) {
  let reloadingForServiceWorker = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForServiceWorker) return;
    reloadingForServiceWorker = true;
    window.location.reload();
  });
  window.addEventListener("load", async () => {
    const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    registration.update();
  });
}

async function importFiles(files) {
  if (!files.length || state.busy) return;
  setBusy(true, "Reading files...");
  setProgress("Reading selected files", 1);
  try {
    for (let index = 0; index < files.length; index += 1) {
      setProgress(`Reading ${files[index].name}`, Math.floor((index / files.length) * 10));
      await importOne(files[index]);
    }
    setProgress("Import complete", 100);
    hideProgressSoon();
  } catch (error) {
    console.error("import error", error);
    state.imports.push({ name: "Import error", detail: describeError(error), count: 0, status: "error" });
  } finally {
    setBusy(false);
    fileInput.value = "";
    render();
  }
}

async function stageFiles(files) {
  if (!files.length || state.busy) return;
  setBusy(true, "Reading selected files...");
  setProgress("Reading selected files", 1);
  try {
    for (let index = 0; index < files.length; index += 1) {
      setProgress(`Reading ${files[index].name}`, Math.floor((index / files.length) * 100));
      await stageOne(files[index]);
    }
    setProgress("Files ready to import", 100);
    hideProgressSoon();
  } catch (error) {
    console.error("stage error", error);
    state.imports.push({ name: "Import error", detail: describeError(error), count: 0, status: "error" });
  } finally {
    setBusy(false);
    fileInput.value = "";
    render();
  }
}

async function stageOne(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(file);
    const pdfEntries = Object.values(zip.files)
      .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".pdf"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    if (!pdfEntries.length) {
      state.imports.push({ name: file.name, detail: "No PDFs found", count: 0, status: "error" });
      return;
    }

    for (const entry of pdfEntries) {
      state.pendingFiles.push({
        id: pendingId++,
        name: file.name,
        detail: entry.name,
        kind: "PDF",
        archiveName: file.name,
        pdfName: entry.name,
        getBytes: () => entry.async("uint8array")
      });
    }
    return;
  }

  if (lower.endsWith(".pdf") || file.type === "application/pdf") {
    state.pendingFiles.push({
      id: pendingId++,
      name: file.name,
      detail: "Bare PDF",
      kind: "PDF",
      archiveName: "",
      pdfName: file.name,
      getBytes: async () => new Uint8Array(await file.arrayBuffer())
    });
    return;
  }

  state.imports.push({ name: file.name, detail: "Skipped non-PDF export", count: 0, status: "error" });
}

async function importPendingFiles() {
  const files = getPendingOrderFromDom();
  state.pendingFiles = [];
  render();
  await importFiles(files);
}

async function importOne(file) {
  await importPdf(await file.getBytes(), file.archiveName, file.pdfName);
}

async function importPdf(bytes, archiveName, pdfName) {
  const sourceHash = await sha256(bytes);
  const existing = state.imports.find((item) => item.sourceHash === sourceHash);
  if (existing) {
    state.imports.push({ name: archiveName || pdfName, detail: "Skipped duplicate PDF", count: 0, status: "warn" });
    return;
  }

  updateLog(`Extracting ${archiveName || pdfName}...`);
  setProgress(`Extracting ${archiveName || pdfName}`, 10);
  const pages = await extractPdfPages(bytes, ({ pageNumber, pageCount }) => {
    const pct = 10 + Math.floor((pageNumber / pageCount) * 75);
    setProgress(`Extracting ${archiveName || pdfName}: page ${pageNumber} of ${pageCount}`, pct);
    if (pageNumber === 1 || pageNumber % 100 === 0 || pageNumber === pageCount) {
      updateLog(`Extracting ${archiveName || pdfName}: page ${pageNumber} of ${pageCount}`);
    }
  });
  const text = pages.map((page) => page.text).join("\n\f\n");
  setProgress(`Parsing ${archiveName || pdfName}`, 90);
  const parsed = parseNexisPdfText(text, { archiveName, pdfName, sha256: sourceHash }, pages);
  for (const article of parsed) {
    article.body_sha256 = await sha256(new TextEncoder().encode(article.body));
  }
  state.articles.push(...parsed);
  state.imports.push({
    name: archiveName || pdfName,
    detail: pdfName,
    count: parsed.length,
    sourceHash,
    status: parsed.length ? "ok" : "error"
  });
  render();
}

function render() {
  const articleCount = state.articles.length;
  document.querySelector("#articleCount").textContent = articleCount.toLocaleString();
  document.querySelector("#fileCount").textContent = state.imports
    .filter((item) => item.status === "ok")
    .length.toLocaleString();
  document.querySelector("#jobCount").textContent = new Set(state.articles.map((article) => article.job_number).filter(Boolean)).size.toLocaleString();

  downloadSqlite.disabled = !articleCount || state.busy;
  downloadExcel.disabled = !articleCount || state.busy;
  downloadCsv.disabled = !articleCount || state.busy;
  clearAll.disabled = (!articleCount && !state.imports.length) || state.busy;
  clearPending.disabled = !state.pendingFiles.length || state.busy;
  importPending.disabled = !state.pendingFiles.length || state.busy;
  filterInput.disabled = !articleCount;

  renderPendingFiles();
  renderImports();
  renderArticles();
}

function renderPendingFiles() {
  pendingPanel.hidden = !state.pendingFiles.length;
  if (!state.pendingFiles.length) {
    pendingList.innerHTML = "";
    return;
  }

  pendingList.innerHTML = state.pendingFiles
    .map(
      (file, index) => `
        <div class="pending-row" draggable="${!state.busy}" data-index="${index}" data-id="${file.id}">
          <span class="drag-handle" aria-hidden="true">::</span>
          <span class="pending-index">${index + 1}</span>
          <span class="pending-name">${escapeHtml(file.name)}</span>
          <span class="pending-detail">${escapeHtml(file.detail)}</span>
          <span class="pending-kind">${escapeHtml(file.kind)}</span>
          <button class="ghost remove-pending" data-index="${index}" ${state.busy ? "disabled" : ""}>Remove</button>
        </div>
      `
    )
    .join("");

  pendingList.querySelectorAll(".pending-row").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.index);
      row.classList.add("dragging-row");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging-row"));
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData("text/plain"));
      const to = Number(row.dataset.index);
      movePendingFile(from, to);
    });
  });

  pendingList.querySelectorAll(".remove-pending").forEach((button) => {
    button.addEventListener("click", () => {
      state.pendingFiles.splice(Number(button.dataset.index), 1);
      render();
    });
  });
}

function movePendingFile(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
  const [file] = state.pendingFiles.splice(from, 1);
  state.pendingFiles.splice(to, 0, file);
  render();
}

function getPendingOrderFromDom() {
  const byId = new Map(state.pendingFiles.map((file) => [String(file.id), file]));
  const ordered = [...pendingList.querySelectorAll(".pending-row")]
    .map((row) => byId.get(row.dataset.id))
    .filter(Boolean);
  return ordered.length === state.pendingFiles.length ? ordered : [...state.pendingFiles];
}

function renderImports() {
  if (!state.imports.length) {
    log.className = "log empty";
    log.textContent = "No files imported yet.";
    return;
  }

  log.className = "log";
  log.innerHTML = state.imports
    .map(
      (item) => `
        <div class="log-row ${item.status}">
          <span>${escapeHtml(item.name)}</span>
          <span>${escapeHtml(item.detail || "")}</span>
          <strong>${item.count.toLocaleString()} rows</strong>
        </div>
      `
    )
    .join("");
}

function renderArticles() {
  const query = filterInput.value.trim().toLowerCase();
  const rows = state.articles
    .map((article, index) => ({ article, index }))
    .filter(({ article }) => {
      if (!query) return true;
    return [article.title, article.publication_date, article.section, article.byline, article.body]
      .concat(article.dateline || "")
      .join(" ")
      .toLowerCase()
      .includes(query);
    });

  const body = document.querySelector("#articleRows");
  if (!state.articles.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">Import files to populate rows.</td></tr>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">No matching articles.</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map(
      ({ article, index }) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(article.title)}</td>
      <td>${escapeHtml(article.publication_date || article.load_date)}</td>
      <td>${escapeHtml(article.section)}</td>
      <td>${escapeHtml(article.byline)}</td>
      <td>${escapeHtml(article.dateline)}</td>
      <td>${escapeHtml(previewText(article.body))}</td>
    </tr>
    `
    )
    .join("");
}

function previewText(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= 220) return compact;
  return `${compact.slice(0, 100)} [...] ${compact.slice(-100)}`;
}

function updateLog(message) {
  log.className = "log empty";
  log.textContent = message;
}

function setBusy(busy, message = "") {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  if (message) updateLog(message);
  render();
}

function setProgress(label, percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  progressPanel.hidden = false;
  progressLabel.textContent = label;
  progressPercent.textContent = `${clamped}%`;
  progressFill.style.width = `${clamped}%`;
}

function hideProgressSoon() {
  window.setTimeout(() => {
    if (!state.busy) progressPanel.hidden = true;
  }, 1200);
}

async function sha256(bytes) {
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return fnv1a32(bytes);
}

function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}

function downloadBlob(content, name, type) {
  const blob = content instanceof Uint8Array ? new Blob([content], { type }) : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function describeError(error) {
  if (!error) return "Unknown error";
  const name = error.name ? `${error.name}: ` : "";
  const message = error.message || String(error);
  const stack = error.stack ? `\n${error.stack}` : "";
  return `${name}${message}${stack}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function initFamilyMenu() {
  const otherSites = FAMILY_SITES.filter((site) => site.name !== CURRENT_SITE_NAME);
  if (!otherSites.length) {
    titleMenuToggle.disabled = true;
    return;
  }

  titleMenu.innerHTML = otherSites
    .map(
      (site) => `
        <a class="title-menu-item" href="${escapeHtml(site.url)}">
          <span class="title-menu-item-name">${escapeHtml(site.name)}</span>
          <span class="title-menu-item-desc">${escapeHtml(site.description)}</span>
        </a>`
    )
    .join("");

  titleMenuToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setFamilyMenuOpen(titleMenuToggle.getAttribute("aria-expanded") !== "true");
  });
  document.addEventListener("click", (event) => {
    if (!titleMenu.hidden && !titleMenu.contains(event.target) && event.target !== titleMenuToggle) {
      setFamilyMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setFamilyMenuOpen(false);
  });
}

function setFamilyMenuOpen(open) {
  titleMenu.hidden = !open;
  titleMenuToggle.setAttribute("aria-expanded", String(open));
}
