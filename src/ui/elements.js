import { APP_HTML } from "./template.js";

// Injects the shell and hands back every element the app wires up. This is a
// function, not module-level constants, because ES module imports evaluate
// before the importing module's body: querying at import time would run before
// the template exists.
export function mountApp(root = document.querySelector("#app")) {
  root.innerHTML = APP_HTML;

  return {
    fileInput: document.querySelector("#fileInput"),
    dropzone: document.querySelector("#dropzone"),
    log: document.querySelector("#log"),
    filterInput: document.querySelector("#filterInput"),
    downloadSqlite: document.querySelector("#downloadSqlite"),
    downloadExcel: document.querySelector("#downloadExcel"),
    downloadCsv: document.querySelector("#downloadCsv"),
    clearAll: document.querySelector("#clearAll"),
    pendingPanel: document.querySelector("#pendingPanel"),
    pendingList: document.querySelector("#pendingList"),
    clearPending: document.querySelector("#clearPending"),
    importPending: document.querySelector("#importPending"),
    progressPanel: document.querySelector("#progressPanel"),
    progressLabel: document.querySelector("#progressLabel"),
    progressPercent: document.querySelector("#progressPercent"),
    progressFill: document.querySelector("#progressFill"),
    titleMenuToggle: document.querySelector("#titleMenuToggle"),
    titleMenu: document.querySelector("#titleMenu"),
    articleCount: document.querySelector("#articleCount"),
    fileCount: document.querySelector("#fileCount"),
    jobCount: document.querySelector("#jobCount"),
    articleRows: document.querySelector("#articleRows")
  };
}
