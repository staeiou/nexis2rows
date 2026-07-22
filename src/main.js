// Entry point: owns app state, the PDF import pipeline, and event wiring.
// DOM rendering lives in src/ui/render.js, the markup in src/ui/template.js.
import "./polyfills.js";
import JSZip from "jszip";
import { createDatabase, exportCsv, exportExcel } from "./database.js";
import { extractPdfPages } from "./pdf.js";
import { parseNexisPdfText } from "./parser.js";
import { sha256 } from "./hash.js";
import { downloadBlob } from "./download.js";
import { mountApp } from "./ui/elements.js";
import { createRenderer } from "./ui/render.js";
import { initFamilyMenu } from "./ui/family-menu.js";
import { describeError } from "./ui/format.js";
import "./styles.css";

const CURRENT_SITE_NAME = "nexis2rows";

const state = {
  imports: [],
  articles: [],
  pendingFiles: [],
  busy: false
};
let pendingId = 1;

const elements = mountApp();
const { render, renderArticles, getPendingOrderFromDom, updateLog, setProgress, hideProgressSoon } =
  createRenderer({ elements, state });

initFamilyMenu(elements, CURRENT_SITE_NAME);

elements.fileInput.addEventListener("change", () => stageFiles([...elements.fileInput.files]));
elements.dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.dropzone.classList.add("dragging");
});
elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("dragging"));
elements.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropzone.classList.remove("dragging");
  stageFiles([...event.dataTransfer.files]);
});
elements.filterInput.addEventListener("input", renderArticles);
elements.clearAll.addEventListener("click", () => {
  state.imports = [];
  state.articles = [];
  render();
});
elements.clearPending.addEventListener("click", () => {
  state.pendingFiles = [];
  elements.fileInput.value = "";
  render();
});
elements.importPending.addEventListener("click", () => importPendingFiles());
elements.downloadSqlite.addEventListener("click", async () => {
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
elements.downloadCsv.addEventListener("click", () => {
  setProgress("Preparing CSV export", 100);
  downloadBlob(exportCsv(state.articles), "nexis2rows.csv", "text/csv;charset=utf-8");
  hideProgressSoon();
});
elements.downloadExcel.addEventListener("click", () => {
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

// The service worker makes the app usable offline. A controllerchange means a
// new build took over, so reload once to avoid running half-old assets.
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

render();

// Uploads are staged first so the user can reorder or drop files before the
// expensive parse; importFiles is what actually reads and parses them.
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
    elements.fileInput.value = "";
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

async function importFiles(files) {
  if (!files.length || state.busy) return;
  setBusy(true, "Reading files...");
  setProgress("Reading selected files", 1);
  try {
    for (let index = 0; index < files.length; index += 1) {
      setProgress(`Reading ${files[index].name}`, Math.floor((index / files.length) * 10));
      await importPdf(await files[index].getBytes(), files[index].archiveName, files[index].pdfName);
    }
    setProgress("Import complete", 100);
    hideProgressSoon();
  } catch (error) {
    console.error("import error", error);
    state.imports.push({ name: "Import error", detail: describeError(error), count: 0, status: "error" });
  } finally {
    setBusy(false);
    elements.fileInput.value = "";
    render();
  }
}

async function importPdf(bytes, archiveName, pdfName) {
  const sourceHash = await sha256(bytes);
  if (state.imports.some((item) => item.sourceHash === sourceHash)) {
    state.imports.push({ name: archiveName || pdfName, detail: "Skipped duplicate PDF", count: 0, status: "warn" });
    return;
  }

  const label = archiveName || pdfName;
  updateLog(`Extracting ${label}...`);
  setProgress(`Extracting ${label}`, 10);

  const pages = await extractPdfPages(bytes, ({ pageNumber, pageCount }) => {
    setProgress(`Extracting ${label}: page ${pageNumber} of ${pageCount}`, 10 + Math.floor((pageNumber / pageCount) * 75));
    if (pageNumber === 1 || pageNumber % 100 === 0 || pageNumber === pageCount) {
      updateLog(`Extracting ${label}: page ${pageNumber} of ${pageCount}`);
    }
  });

  setProgress(`Parsing ${label}`, 90);
  const text = pages.map((page) => page.text).join("\n\f\n");
  const parsed = parseNexisPdfText(text, { archiveName, pdfName, sha256: sourceHash }, pages);
  for (const article of parsed) {
    article.body_sha256 = await sha256(new TextEncoder().encode(article.body));
  }

  state.articles.push(...parsed);
  state.imports.push({
    name: label,
    detail: pdfName,
    count: parsed.length,
    sourceHash,
    status: parsed.length ? "ok" : "error"
  });
  render();
}

function setBusy(busy, message = "") {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  if (message) updateLog(message);
  render();
}
