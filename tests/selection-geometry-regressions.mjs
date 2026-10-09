import { selectionCases } from "./selection-cases.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { openTestPage } from "./test-page.mjs";
const source =
    process.argv[2] ||
    (existsSync("leaf-note.html") ? "leaf-note.html" : "LeafNote.html"),
  engine = process.argv[3] || "chrome";
const page = await openTestPage({
  source,
  engine,
  ready: "window.__LeafNoteTest?.isReady()",
});
try {
  console.log("Browser:", engine, page.version);
  const results = await page.evaluate(selectionCases);
  assert.equal(results.length, 10);
  for (const result of results) console.log("PASS:", result);
} finally {
  await page.close();
}
