# nu2db

Offline browser app for converting Nexis Uni PDF exports into one SQLite database.

## Current scope

- Supports `.zip` files containing Nexis Uni PDF exports.
- Supports direct `.pdf` uploads.
- Parses the current Nexis Uni PDF layout that separates articles with `End of Document`.
- Exports:
  - `nu2db.sqlite` with an `articles` table
  - `nu2db.csv`

## Development

```sh
npm install
npm run dev
```

