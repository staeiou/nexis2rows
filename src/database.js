import initSqlJs from "sql.js";
import * as XLSX from "xlsx";

const EXCEL_CELL_TEXT_LIMIT = 32760;

const ARTICLE_COLUMNS = [
  "source_archive",
  "source_pdf",
  "source_sha256",
  "nexis_link",
  "source_article_ordinal",
  "delivery_date",
  "job_number",
  "search_terms",
  "search_type",
  "title",
  "publication",
  "publication_date",
  "section",
  "length",
  "byline",
  "dateline",
  "load_date",
  "body",
  "body_sha256",
  "raw_text"
];

export async function createDatabase(articles) {
  const SQL = await initSqlJs({ locateFile: locateSqlWasm });
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      source_archive TEXT,
      source_pdf TEXT,
      source_sha256 TEXT,
      nexis_link TEXT,
      source_article_ordinal INTEGER,
      delivery_date TEXT,
      job_number TEXT,
      search_terms TEXT,
      search_type TEXT,
      title TEXT,
      publication TEXT,
      publication_date TEXT,
      section TEXT,
      length TEXT,
      byline TEXT,
      dateline TEXT,
      load_date TEXT,
      body TEXT,
      body_sha256 TEXT,
      raw_text TEXT
    );
    CREATE INDEX idx_articles_job_number ON articles(job_number);
    CREATE INDEX idx_articles_publication_date ON articles(publication_date);
    CREATE INDEX idx_articles_title ON articles(title);
  `);

  const placeholders = ARTICLE_COLUMNS.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO articles (${ARTICLE_COLUMNS.join(", ")}) VALUES (${placeholders})`
  );

  db.run("BEGIN");
  try {
    for (const article of articles) {
      insert.run(ARTICLE_COLUMNS.map((column) => article[column] ?? ""));
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally {
    insert.free();
  }

  return db.export();
}

export function exportCsv(articles) {
  const columns = ["row", ...ARTICLE_COLUMNS.filter((column) => column !== "raw_text")];
  const rows = [
    columns,
    ...articles.map((article, index) =>
      columns.map((column) => (column === "row" ? index + 1 : article[column] ?? ""))
    )
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function exportExcel(articles) {
  const baseColumns = ["row", ...ARTICLE_COLUMNS.filter((column) => column !== "raw_text")];
  const baseRows = articles.map((article, index) => {
    const row = { row: index + 1 };
    for (const column of baseColumns.slice(1)) row[column] = article[column] ?? "";
    return row;
  });
  const { columns, rows } = splitLongExcelCells(baseColumns, baseRows);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });
  sheet["!cols"] = columns.map((column) => ({ wch: column === "body" || column.startsWith("body.continued.") ? 80 : 24 }));
  XLSX.utils.book_append_sheet(workbook, sheet, "articles");
  return XLSX.write(workbook, { bookType: "xlsx", type: "array" });
}

function splitLongExcelCells(baseColumns, baseRows) {
  const continuationCounts = new Map();
  for (const row of baseRows) {
    for (const column of baseColumns) {
      const value = row[column];
      if (typeof value !== "string" || value.length <= EXCEL_CELL_TEXT_LIMIT) continue;
      const count = Math.ceil(value.length / EXCEL_CELL_TEXT_LIMIT) - 1;
      continuationCounts.set(column, Math.max(continuationCounts.get(column) || 0, count));
    }
  }

  const columns = [];
  for (const column of baseColumns) {
    columns.push(column);
    const count = continuationCounts.get(column) || 0;
    for (let index = 1; index <= count; index += 1) {
      columns.push(`${column}.continued.${index}`);
    }
  }

  const rows = baseRows.map((baseRow) => {
    const row = {};
    for (const column of baseColumns) {
      const value = baseRow[column];
      if (typeof value !== "string" || value.length <= EXCEL_CELL_TEXT_LIMIT) {
        row[column] = value;
      } else {
        const chunks = chunkString(value, EXCEL_CELL_TEXT_LIMIT);
        row[column] = chunks[0] || "";
        for (let index = 1; index < chunks.length; index += 1) {
          row[`${column}.continued.${index}`] = chunks[index];
        }
      }
    }
    return row;
  });

  return { columns, rows };
}

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function csvCell(value) {
  const string = String(value ?? "");
  if (/[",\n\r]/.test(string)) return `"${string.replace(/"/g, '""')}"`;
  return string;
}

function locateSqlWasm(file) {
  const wasmFile = file.endsWith(".wasm") ? "sql-wasm.wasm" : file;
  return new URL(wasmFile, new URL(import.meta.env.BASE_URL, window.location.origin)).href;
}
