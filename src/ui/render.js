import { ARTICLE_TABLE_COLUMNS } from "./template.js";
import { escapeHtml, previewText } from "./format.js";

// All DOM writing lives here. `createRenderer` closes over the element map and
// the shared state object so the render functions can call each other (a row's
// Remove button mutates state and re-renders) without main.js threading
// callbacks through every call.
export function createRenderer({ elements, state }) {
  function render() {
    const articleCount = state.articles.length;
    elements.articleCount.textContent = articleCount.toLocaleString();
    elements.fileCount.textContent = state.imports
      .filter((item) => item.status === "ok")
      .length.toLocaleString();
    elements.jobCount.textContent = new Set(
      state.articles.map((article) => article.job_number).filter(Boolean)
    ).size.toLocaleString();

    elements.downloadSqlite.disabled = !articleCount || state.busy;
    elements.downloadExcel.disabled = !articleCount || state.busy;
    elements.downloadCsv.disabled = !articleCount || state.busy;
    elements.clearAll.disabled = (!articleCount && !state.imports.length) || state.busy;
    elements.clearPending.disabled = !state.pendingFiles.length || state.busy;
    elements.importPending.disabled = !state.pendingFiles.length || state.busy;
    elements.filterInput.disabled = !articleCount;

    renderPendingFiles();
    renderImports();
    renderArticles();
  }

  function renderPendingFiles() {
    elements.pendingPanel.hidden = !state.pendingFiles.length;
    if (!state.pendingFiles.length) {
      elements.pendingList.innerHTML = "";
      return;
    }

    elements.pendingList.innerHTML = state.pendingFiles
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

    elements.pendingList.querySelectorAll(".pending-row").forEach((row) => {
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
        movePendingFile(Number(event.dataTransfer.getData("text/plain")), Number(row.dataset.index));
      });
    });

    elements.pendingList.querySelectorAll(".remove-pending").forEach((button) => {
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

  // Drag-and-drop reordering rewrites the DOM directly, so the DOM -- not
  // state.pendingFiles -- is the source of truth for import order. Fall back to
  // state order if the two ever disagree.
  function getPendingOrderFromDom() {
    const byId = new Map(state.pendingFiles.map((file) => [String(file.id), file]));
    const ordered = [...elements.pendingList.querySelectorAll(".pending-row")]
      .map((row) => byId.get(row.dataset.id))
      .filter(Boolean);
    return ordered.length === state.pendingFiles.length ? ordered : [...state.pendingFiles];
  }

  function renderImports() {
    if (!state.imports.length) {
      elements.log.className = "log empty";
      elements.log.textContent = "No files imported yet.";
      return;
    }

    elements.log.className = "log";
    elements.log.innerHTML = state.imports
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
    const query = elements.filterInput.value.trim().toLowerCase();
    const rows = state.articles
      .map((article, index) => ({ article, index }))
      .filter(({ article }) => {
        if (!query) return true;
        return [article.title, article.publication, article.publication_date, article.section, article.byline, article.body]
          .concat(article.dateline || "")
          .join(" ")
          .toLowerCase()
          .includes(query);
      });

    if (!state.articles.length) {
      elements.articleRows.innerHTML = `<tr><td colspan="${ARTICLE_TABLE_COLUMNS}" class="muted">Import files to populate rows.</td></tr>`;
      return;
    }
    if (!rows.length) {
      elements.articleRows.innerHTML = `<tr><td colspan="${ARTICLE_TABLE_COLUMNS}" class="muted">No matching articles.</td></tr>`;
      return;
    }

    elements.articleRows.innerHTML = rows
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

  function updateLog(message) {
    elements.log.className = "log empty";
    elements.log.textContent = message;
  }

  function setProgress(label, percent) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    elements.progressPanel.hidden = false;
    elements.progressLabel.textContent = label;
    elements.progressPercent.textContent = `${clamped}%`;
    elements.progressFill.style.width = `${clamped}%`;
  }

  function hideProgressSoon() {
    window.setTimeout(() => {
      if (!state.busy) elements.progressPanel.hidden = true;
    }, 1200);
  }

  return {
    render,
    renderArticles,
    getPendingOrderFromDom,
    updateLog,
    setProgress,
    hideProgressSoon
  };
}
