// Entry point: owns app state, the PDF import pipeline, and event wiring.
// DOM rendering lives in src/ui/render.js, the markup in src/ui/template.js.
import "./polyfills.js";
import JSZip from "jszip";
import { createDatabase, exportCsv, exportExcel } from "./database.js";
import { extractPdfPages } from "./pdf.js";
import { parseNexisPdfText } from "./parser.js";
import {
  readPdfDelivery,
  readDocxDelivery,
  createDeliveryIndex,
  recordDelivery,
  fillProvenance,
  reconcileTitles,
  isCompanion
} from "./delivery.js";
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

// Uploads are staged first so the user can reorder or drop imports before the
// expensive parse. A ZIP stays one staged import even though it may contain
// many source files; it is expanded only after the user chooses its position.
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

// Nexis exports in either format, singly or zipped, with or without the
// bibliography companion files -- and every combination of those turns up in
// practice, including a ZIP holding all of them at once.
function sourceKind(name, type = "") {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".pdf") || type === "application/pdf") return "PDF";
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "DOCX";
  return "";
}

async function stageOne(file) {
  if (file.name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files)
      .filter((entry) => !entry.dir && sourceKind(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    if (!entries.length) {
      state.imports.push({ name: file.name, detail: "No PDF or DOCX files found", count: 0, status: "error" });
      return;
    }

    state.pendingFiles.push({
      id: pendingId++,
      name: file.name,
      detail: `${entries.length.toLocaleString()} file${entries.length === 1 ? "" : "s"} in ZIP`,
      kind: "ZIP",
      sources: entries.map((entry) => ({
        name: file.name,
        detail: entry.name,
        kind: sourceKind(entry.name),
        archiveName: file.name,
        pdfName: entry.name,
        getBytes: () => entry.async("uint8array")
      }))
    });
    return;
  }

  const kind = sourceKind(file.name, file.type);
  if (kind) {
    state.pendingFiles.push({
      id: pendingId++,
      name: file.name,
      detail: `Bare ${kind}`,
      kind,
      sources: [{
        name: file.name,
        detail: `Bare ${kind}`,
        kind,
        archiveName: "",
        pdfName: file.name,
        getBytes: async () => new Uint8Array(await file.arrayBuffer())
      }]
    });
    return;
  }

  state.imports.push({ name: file.name, detail: "Skipped: not a PDF, DOCX, or ZIP", count: 0, status: "error" });
}

async function importPendingFiles() {
  const files = getPendingOrderFromDom().flatMap((item) => item.sources);
  state.pendingFiles = [];
  render();
  await importFiles(files);
}

async function importFiles(files) {
  if (!files.length || state.busy) return;
  setBusy(true, "Reading files...");
  setProgress("Reading selected files", 1);
  // Provenance found in a doclist, keyed by the archive it came from. Collected
  // as we go and applied at the end, so it does not matter whether the doclist
  // is read before or after the articles it describes.
  const deliveries = createDeliveryIndex();
  try {
    for (let index = 0; index < files.length; index += 1) {
      setProgress(`Reading ${files[index].name}`, Math.floor((index / files.length) * 10));
      await importSource(files[index], deliveries);
    }
    applyDeliveryProvenance(deliveries);
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

// Reads one staged file in whichever format it arrived in, then routes it: a
// real export is parsed into rows, a bibliography companion contributes
// provenance instead. Both formats reduce to the same page entries, so
// src/parser.js does not know or care which one it was handed.
async function importSource(file, deliveries) {
  const { archiveName, pdfName, kind } = file;
  const bytes = await file.getBytes();
  const sourceHash = await sha256(bytes);
  const label = pdfName || archiveName;

  if (state.imports.some((item) => item.sourceHash === sourceHash)) {
    state.imports.push({ name: label, detail: `Skipped duplicate ${kind}`, count: 0, status: "warn" });
    return;
  }

  updateLog(`Reading ${label}...`);
  setProgress(`Reading ${label}`, 10);

  const read = kind === "DOCX" ? await readDocxDelivery(bytes) : await readPdfSource(bytes, label);
  const deliveryKey = archiveName || pdfName;

  if (isCompanion(read.classification)) {
    recordDelivery(deliveries, deliveryKey, read);
    state.imports.push({
      name: label,
      detail:
        read.classification === "doclist"
          ? `Bibliography: ${read.titles.length} document${read.titles.length === 1 ? "" : "s"} listed`
          : `Bibliography: ${read.citations.length} citation${read.citations.length === 1 ? "" : "s"}`,
      count: 0,
      sourceHash,
      status: "ok"
    });
    render();
    return;
  }

  if (read.classification !== "articles") {
    state.imports.push({
      name: label,
      detail: `No Nexis documents found in this ${kind}`,
      count: 0,
      sourceHash,
      status: "error"
    });
    render();
    return;
  }

  setProgress(`Parsing ${label}`, 90);
  const text = read.pages.map((page) => page.text).join("\n\f\n");
  const parsed = parseNexisPdfText(
    text,
    { archiveName, pdfName, sha256: sourceHash },
    read.pages,
    { headerText: read.headerText }
  );
  for (const article of parsed) {
    article.body_sha256 = await sha256(new TextEncoder().encode(article.body));
    article.delivery_key = deliveryKey;
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

async function readPdfSource(bytes, label) {
  const pages = await extractPdfPages(bytes, ({ pageNumber, pageCount }) => {
    setProgress(`Extracting ${label}: page ${pageNumber} of ${pageCount}`, 10 + Math.floor((pageNumber / pageCount) * 75));
    if (pageNumber === 1 || pageNumber % 100 === 0 || pageNumber === pageCount) {
      updateLog(`Extracting ${label}: page ${pageNumber} of ${pageCount}`);
    }
  });
  return readPdfDelivery(pages);
}

// Report what the doclist expected against what actually parsed, so a partial
// import is visible instead of being silently short.
function applyDeliveryProvenance(deliveries) {
  for (const [key, delivery] of deliveries) {
    const rows = state.articles.filter((article) => article.delivery_key === key);
    if (!rows.length) continue;

    fillProvenance(rows, delivery.headerText);

    if (delivery.titles.length) {
      const { listed, found, missing } = reconcileTitles(rows, delivery.titles);
      state.imports.push({
        name: key,
        detail: `${found} of ${listed} listed documents parsed`,
        count: rows.length,
        status: missing.length ? "warn" : "ok"
      });
    }
  }
  for (const article of state.articles) delete article.delivery_key;
  render();
}

function setBusy(busy, message = "") {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  if (message) updateLog(message);
  render();
}
