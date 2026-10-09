import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse, parseFragment } from "parse5";
import { parse as parseJS } from "acorn";
const output = process.argv[2] || "reports/ui-inventory.json";
const app = existsSync("src/LeafNote.html.in")
  ? "src/LeafNote.html.in"
  : existsSync("leaf-note.html")
    ? "leaf-note.html"
    : "LeafNote.html";
const files = [
  app,
  "index.html",
  ...(existsSync("Maskinger.html") ? ["Maskinger.html"] : []),
];
const background = [];
const registrations = [],
  controls = [],
  templates = [],
  functions = [];
function walkJS(node, visit, parent = null, ownerFunction = null) {
  if (!node || typeof node !== "object") return;
  const owner =
    node.type === "ClassDeclaration"
      ? node.id?.name
      : node.type === "MethodDefinition"
        ? `${ownerFunction}.${node.key.name || node.key.value}`
        : node.type === "FunctionDeclaration"
          ? node.id?.name
          : ownerFunction;
  if (node.type) visit(node, parent, owner);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue;
    if (Array.isArray(value))
      for (const child of value) walkJS(child, visit, node, owner);
    else if (value && typeof value === "object")
      walkJS(value, visit, node, owner);
  }
}
for (const file of files) {
  const source = await readFile(file, "utf8");
  const scripts = [];
  const addControls = (root, origin) => {
    const visit = (node) => {
      const attrs = Object.fromEntries(
        (node.attrs || []).map((attr) => [attr.name, attr.value]),
      );
      if (
        ["button", "input", "select", "textarea", "summary"].includes(
          node.tagName,
        ) ||
        (node.tagName === "a" && attrs.href) ||
        attrs.contenteditable ||
        attrs.role === "button"
      ) {
        const text =
          node.childNodes
            ?.filter((child) => child.nodeName === "#text")
            .map((child) => child.value.trim())
            .join(" ") || "";
        controls.push({
          file,
          origin,
          line: node.sourceCodeLocation?.startLine,
          id: attrs.id || null,
          tag: node.tagName,
          label:
            attrs["aria-label"] ||
            attrs.title ||
            attrs.placeholder ||
            text.slice(0, 160),
          attributes: attrs,
          measurementStatus:
            "Not independently timed; match to representative cases in coverage matrix.",
        });
      }
      for (const attr of node.attrs || [])
        if (/^on[a-z]+$/.test(attr.name))
          registrations.push({
            file,
            origin,
            event: attr.name.slice(2),
            target: attrs.id || node.tagName,
            handler: attr.value,
            kind: "HTML event attribute",
            measurementStatus:
              "Unmeasured unless mapped to a representative case",
          });
      if (node.tagName === "script" && origin === "document") {
        const type = attrs.type || "";
        if (
          ["", "module", "text/javascript", "application/javascript"].includes(
            type,
          ) &&
          node.sourceCodeLocation?.endTag
        ) {
          const loc = node.sourceCodeLocation;
          scripts.push({
            text: source.slice(loc.startTag.endOffset, loc.endTag.startOffset),
            offset: loc.startTag.endOffset,
            line: loc.startTag.endLine,
            module: type === "module",
          });
        }
      }
      for (const child of node.childNodes || []) visit(child);
      if (node.content) visit(node.content);
    };
    visit(root);
  };
  addControls(parse(source, { sourceCodeLocationInfo: true }), "document");
  for (const script of scripts) {
    const ast = parseJS(script.text, {
      ecmaVersion: 2026,
      sourceType: script.module ? "module" : "script",
      locations: true,
    });
    const text = (node) =>
      script.text.slice(node.start, node.end).slice(0, 240);
    const line = (node) => script.line + node.loc.start.line - 1;
    const calls = (handler) => {
      const names = new Set();
      walkJS(handler, (node) => {
        if (node.type === "CallExpression") names.add(text(node.callee));
      });
      return Array.from(names);
    };
    walkJS(ast, (node, parent, ownerFunction) => {
      if (node.type === "MethodDefinition")
        functions.push({
          file,
          line: line(node),
          name: ownerFunction,
          kind: "class method",
          lines: node.loc.end.line - node.loc.start.line + 1,
        });
      if (node.type === "FunctionDeclaration")
        functions.push({
          file,
          line: line(node),
          name: node.id?.name,
          lines: node.loc.end.line - node.loc.start.line + 1,
        });
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.property.name === "addEventListener"
      )
        registrations.push({
          file,
          line: line(node),
          ownerFunction: ownerFunction || "<top-level>",
          origin: "script",
          kind: "addEventListener",
          target: text(node.callee.object),
          event: node.arguments[0]?.value || text(node.arguments[0]),
          calledFunctions: calls(node.arguments[1]),
          handler: text(node.arguments[1]),
          handlerSource: script.text.slice(
            node.arguments[1].start,
            node.arguments[1].end,
          ),
          measurementStatus:
            "Unmeasured unless mapped to a representative case",
        });
      if (
        node.type === "AssignmentExpression" &&
        node.left.type === "MemberExpression" &&
        /^on[a-z]+$/.test(node.left.property.name || "")
      )
        registrations.push({
          file,
          line: line(node),
          ownerFunction: ownerFunction || "<top-level>",
          origin: "script",
          kind: "event property",
          target: text(node.left.object),
          event: node.left.property.name.slice(2),
          calledFunctions: calls(node.right),
          handler: text(node.right),
          handlerSource: script.text.slice(node.right.start, node.right.end),
          measurementStatus:
            "Unmeasured unless mapped to a representative case",
        });
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        [
          "setTimeout",
          "setInterval",
          "requestAnimationFrame",
          "requestIdleCallback",
        ].includes(node.callee.name)
      )
        background.push({
          file,
          line: line(node),
          ownerFunction: ownerFunction || "<top-level>",
          api: node.callee.name,
          callback: text(node.arguments[0]),
          delay: node.arguments[1] ? text(node.arguments[1]) : null,
          measurementStatus:
            "Background work; check associated operation and cancellation",
        });
      if (
        node.type === "Literal" &&
        typeof node.value === "string" &&
        /<(?:button|input|select|textarea|summary|a)\b|contenteditable|role=["']button/.test(
          node.value,
        )
      )
        addControls(
          parseFragment(node.value, { sourceCodeLocationInfo: true }),
          `string:${line(node)}`,
        );
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.property.name === "createElement" &&
        ["button", "input", "select", "textarea", "summary", "a"].includes(
          node.arguments[0]?.value,
        )
      )
        controls.push({
          file,
          origin: `createElement:${line(node)}`,
          line: line(node),
          ownerFunction: ownerFunction || "<top-level>",
          tag: node.arguments[0].value,
          target:
            parent?.type === "VariableDeclarator" ? text(parent.id) : null,
          label: "Assigned dynamically; see source and event registration",
          measurementStatus:
            "Not independently timed; match to representative cases in coverage matrix.",
        });
      if (
        node.type === "TemplateLiteral" &&
        node.quasis.some((part) =>
          /<(?:button|input|select|textarea|summary|a)\b|contenteditable|role=["']button/.test(
            part.value.raw,
          ),
        )
      ) {
        const template = node.quasis
          .map(
            (part, index) =>
              part.value.cooked +
              (index < node.expressions.length
                ? `__expression_${index}__`
                : ""),
          )
          .join("");
        templates.push({
          file,
          line: line(node),
          parent: parent?.type,
          expressions: node.expressions.length,
        });
        addControls(
          parseFragment(template, { sourceCodeLocationInfo: true }),
          `template:${line(node)}`,
        );
      }
    });
  }
}
const result = {
  date: new Date().toISOString(),
  root: resolve("."),
  files,
  counts: {
    registrations: registrations.length,
    background: background.length,
    controls: controls.length,
    templates: templates.length,
    functions: functions.length,
  },
  limits: [
    "Static registrations and templates are inventory entries, not distinct user-operation counts. One delegated handler can implement many actions; loops can produce many controls.",
    "Template interpolation is represented by placeholders; source expressions and browser execution remain authoritative.",
    "Dynamic DOM controls created with createElement may appear only in event registrations. The inventory does not prove functional or timing coverage.",
    "Generated application HTML and index embedded JSON are excluded from source counting. Index own controls/scripts are included.",
  ],
  background,
  registrations,
  controls,
  templates,
  functions,
};
await writeFile(output, JSON.stringify(result, null, 2));
console.log(result.counts);
