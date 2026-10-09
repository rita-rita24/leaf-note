#!/usr/bin/env node
import { minify } from "terser";
import { readFile, writeFile } from "node:fs/promises";
const input = new URL("../src/LeafNote.html.in", import.meta.url);
const output = new URL("../LeafNote.html", import.meta.url);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
  throw new Error("Usage: node scripts/build-app.mjs [--check]");
const source = await readFile(input, "utf8");
// Only compile the application script. Embedded data, styles, icon, license and
// global API names remain intact; no runtime dependency or external asset fetch.
const start = source.indexOf("<script>");
const end = source.indexOf("</script>", start);
if (start < 0 || end < 0) throw new Error("Application script not found");
const result = await minify(source.slice(start + 8, end), {
  compress: { passes: 2, unsafe: false },
  mangle: { toplevel: false },
  format: { inline_script: true, comments: /^!|@preserve|@license|@cc_on/i },
});
if (!result.code || /<\/script\s*>/i.test(result.code))
  throw new Error("Unsafe or empty generated script");
const built = source.slice(0, start + 8) + result.code + source.slice(end);
if (args[0] === "--check") {
  if ((await readFile(output, "utf8")) !== built)
    throw new Error("LeafNote.html is stale. Run npm run build.");
  console.log("Compiled HTML check passed.");
} else {
  await writeFile(output, built);
  console.log("Built LeafNote.html from readable src/LeafNote.html.in.");
}
