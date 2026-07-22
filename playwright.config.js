import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive the real app in a real browser: PDF parsing happens in
// a Web Worker and SQLite export runs WASM, neither of which can be exercised
// from Node. Specs live in e2e/ rather than tests/, because tests/ is gitignored
// (it holds copyrighted Nexis fixtures).
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // Parsing a few hundred PDF pages in-browser is slow but bounded.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}/nexis2rows/`,
    trace: "retain-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/nexis2rows/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
