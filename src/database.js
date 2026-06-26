import initSqlJs from "sql.js";
import * as XLSX from "xlsx";

const ARTICLE_COLUMNS = [
  "source_archive",
  "source_pdf",
  "source_sha256",
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
  "load_date",
  "body",
  "abstract",
  "body_sha256",
  "raw_text"
];

export async function createDatabase(articles) {
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY,
      source_archive TEXT,
      source_pdf TEXT,
      source_sha256 TEXT,
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
      load_date TEXT,
      body TEXT,
      abstract TEXT,
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
  const columns = ["row", ...ARTICLE_COLUMNS.filter((column) => column !== "raw_text")];
  const rows = articles.map((article, index) => {
    const row = { row: index + 1 };
    for (const column of columns.slice(1)) row[column] = article[column] ?? "";
    return row;
  });
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });
  sheet["!cols"] = columns.map((column) => ({ wch: column === "body" ? 80 : 24 }));
  XLSX.utils.book_append_sheet(workbook, sheet, "articles");
  return XLSX.write(workbook, { bookType: "xlsx", type: "array" });
}

function csvCell(value) {
  const string = String(value ?? "");
  if (/[",\n\r]/.test(string)) return `"${string.replace(/"/g, '""')}"`;
  return string;
}
