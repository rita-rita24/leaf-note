#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appPath = fileURLToPath(new URL('../LeafNote.html', import.meta.url));
const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));

function findSourceRange(indexSource) {
  const sources = [];
  // Consume complete script elements so tag-like text inside JavaScript is not
  // mistaken for another source element. Comments are skipped for the same reason.
  const scripts = /<!--[\s\S]*?-->|<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  const closingScript = /<\/script\s*>/gi;
  let match;
  while ((match = scripts.exec(indexSource))) {
    if (match[1] === undefined) continue;
    const start = scripts.lastIndex;
    closingScript.lastIndex = start;
    const closing = closingScript.exec(indexSource);
    if (!closing) throw new Error('index.html contains a script without its closing tag.');
    scripts.lastIndex = closingScript.lastIndex;
    const attributes = new Map();
    const attributePattern = /([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const attribute of match[1].matchAll(attributePattern)) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      if (attributes.has(name) && (name === 'id' || name === 'type')) {
        throw new Error(`A script has duplicate ${name} attributes; fix its markup before syncing.`);
      }
      attributes.set(name, value);
    }
    if (attributes.get('id') !== 'leafnote-source') continue;
    if (attributes.get('type')?.toLowerCase() !== 'application/json') {
      throw new Error('#leafnote-source must use type="application/json".');
    }
    sources.push({ start, end: closing.index, payload: indexSource.slice(start, closing.index) });
  }
  if (sources.length !== 1) {
    throw new Error(`Expected exactly one complete script#leafnote-source; found ${sources.length}.`);
  }
  return sources[0];
}

function readEmbeddedSource(payload) {
  // Escaping every '<' also prevents a source file's closing script tags from
  // terminating this JSON data element early in the HTML parser.
  if (payload.includes('<')) {
    throw new Error('#leafnote-source contains a literal "<"; it must be escaped as \\u003c.');
  }
  let embedded;
  try {
    embedded = JSON.parse(payload);
  } catch {
    throw new Error('#leafnote-source is not valid JSON.');
  }
  if (typeof embedded !== 'string') {
    throw new Error('#leafnote-source must contain a JSON string.');
  }
  return embedded;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/sync-distribution.mjs [--check]');
  }
  const checkOnly = args[0] === '--check';
  const [appSource, indexSource] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(indexPath, 'utf8')
  ]);
  if (!appSource.trim()) throw new Error('LeafNote.html is empty.');
  const source = findSourceRange(indexSource);
  const embeddedSource = readEmbeddedSource(source.payload);
  if (checkOnly) {
    if (embeddedSource !== appSource) {
      throw new Error('index.html contains an outdated LeafNote.html. Run npm run build, then review both files.');
    }
    console.log('Distribution check passed: index.html embeds the current LeafNote.html.');
    return;
  }
  const payload = JSON.stringify(appSource).replace(/</g, '\\u003c');
  const updated = indexSource.slice(0, source.start) + payload + indexSource.slice(source.end);
  // Validate the exact output before writing. Only the JSON payload is replaced.
  const updatedSource = findSourceRange(updated);
  if (readEmbeddedSource(updatedSource.payload) !== appSource) {
    throw new Error('Distribution validation failed; index.html was not written.');
  }
  if (updated === indexSource) {
    console.log('Distribution is already synchronized.');
    return;
  }
  await writeFile(indexPath, updated, 'utf8');
  console.log('Synchronized LeafNote.html into index.html.');
}

main().catch((error) => {
  console.error(`Distribution error: ${error.message}`);
  process.exitCode = 1;
});
