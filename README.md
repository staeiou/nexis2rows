# nexis2rows

Offline browser app for converting Nexis Uni PDF exports into one SQLite database.

## Current scope

- Supports direct Nexis Uni `.pdf` uploads.
- Supports `.zip` files containing Nexis Uni PDF exports.
- Expands ZIPs into pending PDFs that can be reordered before import.
- Parses the current Nexis Uni PDF layout that separates articles with `End of Document`.
- Exports:
  - `nexis2rows.sqlite` with an `articles` table
  - `nexis2rows.xlsx`
  - `nexis2rows.csv`

## Development

```sh
npm install
npm run dev
```
