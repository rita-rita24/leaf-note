import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJavaScript } from "acorn";
import { parse as parseHTML } from "parse5";
import postcss from "postcss";
import { Linter } from "eslint";
import globals from "globals";

const root = path.resolve(import.meta.dirname, "..");
const fix = process.argv.includes("--fix");
const output = process.argv
  .find((arg) => arg.startsWith("--output="))
  ?.slice(9);
const linter = new Linter();
const report = {
  date: new Date().toISOString(),
  root,
  files: [],
  findings: [],
  migrations: [],
  exclusions: [
    ".git: repository metadata",
    "node_modules: locked external dependencies",
    "reports: historical evidence and frozen release snapshots",
  ],
  limits: [
    "Dynamic JavaScript assembled at runtime is covered by browser regression tests, not fully by this static parser.",
    "CSS parsing checks syntax, not target-browser compatibility.",
    "HTML parsing and obsolete element checks are not a full HTML conformance validator.",
  ],
};
const rules = {
  "no-var": "error",
  "prefer-const": "error",
  "no-undef": "error",
  "no-async-promise-executor": "error",
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  "no-unsafe-finally": "error",
  "no-new-wrappers": "error",
  "no-loss-of-precision": "error",
};
const appGlobals = {};
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === "object") walk(value, visit);
  }
}
async function files(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "reports"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await files(file)));
    else if (/\.(?:mjs|js|html|html\.in|css|json|py|ya?ml)$/.test(file))
      out.push(file);
  }
  return out.sort();
}
const inventory = await files(root);
const units = [];
for (const file of inventory) {
  const relative = path.relative(root, file);
  const source = await readFile(file, "utf8");
  const generated =
    relative === "LeafNote.html" &&
    inventory.includes(path.join(root, "src/LeafNote.html.in"));
  const entry = {
    file: relative,
    bytes: Buffer.byteLength(source),
    generated,
    language: path.extname(file),
    scripts: 0,
    styles: 0,
  };
  report.files.push(entry);
  if (/\.html(?:\.in)?$/.test(file)) {
    const html = parseHTML(source, {
      sourceCodeLocationInfo: true,
      onParseError(error) {
        report.findings.push({
          file: relative,
          rule: "HTML parser",
          line: error.startLine,
          message: error.code,
        });
      },
    });
    const visit = (node) => {
      const location = node.sourceCodeLocation;
      if (["font", "center", "marquee", "big", "strike"].includes(node.tagName))
        report.findings.push({
          file: relative,
          rule: "obsolete HTML",
          message: node.tagName,
        });
      if (node.tagName === "script" && location?.endTag) {
        const type =
          node.attrs.find((attribute) => attribute.name === "type")?.value ||
          "";
        const text = source.slice(
          location.startTag.endOffset,
          location.endTag.startOffset,
        );
        if (
          ["", "module", "text/javascript", "application/javascript"].includes(
            type,
          )
        ) {
          entry.scripts++;
          units.push({
            file,
            relative,
            source,
            text,
            offset: location.startTag.endOffset,
            module: type === "module",
            generated,
          });
        } else if (type === "application/json" && text.trim()) JSON.parse(text);
      }
      if (node.tagName === "style" && location?.endTag) {
        entry.styles++;
        try {
          postcss.parse(
            source.slice(
              location.startTag.endOffset,
              location.endTag.startOffset,
            ),
            { from: relative },
          );
        } catch (error) {
          report.findings.push({
            file: relative,
            rule: "CSS syntax",
            message: error.reason,
          });
        }
      }
      for (const child of node.childNodes || []) visit(child);
      if (node.content) visit(node.content);
    };
    visit(html);
  } else if (/\.(?:mjs|js)$/.test(file))
    units.push({
      file,
      relative,
      source,
      text: source,
      offset: 0,
      module: true,
      generated,
    });
  else if (file.endsWith(".json")) JSON.parse(source);
  else if (file.endsWith(".css")) postcss.parse(source, { from: relative });
}
for (const unit of units) {
  unit.ast = parseJavaScript(unit.text, {
    ecmaVersion: 2026,
    sourceType: unit.module ? "module" : "script",
    locations: true,
  });
  if (
    unit.relative === "src/LeafNote.html.in" ||
    unit.relative === "leaf-note.html"
  ) {
    for (const node of unit.ast.body) {
      if (node.type === "FunctionDeclaration")
        appGlobals[node.id.name] = "readonly";
      if (node.type === "VariableDeclaration")
        for (const declaration of node.declarations)
          if (declaration.id.type === "Identifier")
            appGlobals[declaration.id.name] = "writable";
    }
  }
}
const edits = new Map();
for (const unit of units) {
  if (unit.generated) continue; // Parsed above; migrate the source, never generated output.
  const config = [
    {
      languageOptions: {
        ecmaVersion: 2026,
        sourceType: unit.module ? "module" : "script",
        globals: { ...globals.browser, ...globals.node, ...appGlobals },
      },
      rules,
    },
  ];
  const results = linter.verify(unit.text, config);
  for (const result of results)
    report.findings.push({
      file: unit.relative,
      rule: result.ruleId,
      line: result.line,
      message: result.message,
    });
  walk(unit.ast, (node) => {
    if (node.type === "CatchClause" && node.param?.type === "Identifier") {
      let used = false;
      walk(node.body, (child) => {
        if (child.type === "Identifier" && child.name === node.param.name)
          used = true;
      });
      if (!used) {
        const finding = {
          file: unit.relative,
          rule: "optional catch binding",
          line: node.loc.start.line,
          message: `Unused catch binding ${node.param.name}`,
        };
        if (fix) {
          const prefix = unit.text.slice(node.start, node.body.start);
          const open = prefix.indexOf("("),
            close = prefix.lastIndexOf(")");
          if (open < 0 || close < open)
            throw new Error("Cannot locate catch binding");
          const list = edits.get(unit.file) || [];
          list.push({
            start: unit.offset + node.start + open,
            end: unit.offset + node.start + close + 1,
          });
          edits.set(unit.file, list);
          report.migrations.push(finding);
        } else report.findings.push(finding);
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const name =
        callee.type === "Identifier"
          ? callee.name
          : !callee.computed
            ? callee.property?.name
            : null;
      if (
        (callee.type === "Identifier" &&
          ["escape", "unescape"].includes(name)) ||
        (callee.type === "MemberExpression" &&
          ["substr", "getYear", "setYear", "detach"].includes(name))
      )
        report.findings.push({
          file: unit.relative,
          rule: "legacy API",
          line: node.loc.start.line,
          message: name,
        });
    }
  });
}
for (const [file, changes] of edits) {
  let source = await readFile(file, "utf8");
  for (const change of changes.sort((a, b) => b.start - a.start))
    source = source.slice(0, change.start) + source.slice(change.end);
  await writeFile(file, source);
}
if (output) await writeFile(output, JSON.stringify(report, null, 2));
for (const finding of report.findings)
  console.error(
    `${finding.file}:${finding.line || 1} ${finding.rule}: ${finding.message}`,
  );
console.log(
  `Audited ${report.files.length} files / ${units.length} JavaScript units; ${report.migrations.length} catch migrations; ${report.findings.length} findings.`,
);
process.exitCode = report.findings.length ? 1 : 0;
