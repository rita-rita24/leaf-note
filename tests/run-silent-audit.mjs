import assert from "node:assert/strict";
import { APP_PATH } from "../scripts/app-path.mjs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
  jsWithArgs,
} from "./run-browser.mjs";

const baselineDir = process.env.QUALITY_BASELINE_DIR;
assert.ok(
  baselineDir,
  "Set QUALITY_BASELINE_DIR to the pre-change HTML directory",
);
const report = { static: [], viewports: [], native: [], performance: [] };
const hash = (text) => createHash("sha256").update(text).digest("hex");
const stripScripts = (text) =>
  text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
for (const file of ["LeafNote.html", "index.html"]) {
  const before = await readFile(path.join(baselineDir, file), "utf8"),
    after = await readFile(file === "LeafNote.html" ? APP_PATH : file, "utf8");
  assert.equal(
    stripScripts(after),
    stripScripts(before),
    `${file}: HTML/CSS changed`,
  );
  let checkedScripts = 0;
  for (const [, attributes, body] of after.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    if (/application\/json|\bsrc\s*=/i.test(attributes)) continue;
    new Script(body, { filename: file });
    checkedScripts++;
  }
  report.static.push({
    file,
    unchangedHtmlCss: true,
    checkedScripts,
    sha256: hash(after),
  });
}

const browsers = [],
  pages = [];
try {
  for (const file of [path.join(baselineDir, "LeafNote.html"), APP_PATH]) {
    const browser = await launchBrowser();
    browsers.push(browser);
    pages.push(
      await openPage(browser.port, {
        url: `${pathToFileURL(file).href}?test=1`,
      }),
    );
  }
  const dictionaries = [];
  for (const page of pages) {
    dictionaries.push(await evaluate(page, "JSON.stringify(I18N)"));
    await evaluate(
      page,
      js(async () => {
        const api = window.__LeafNoteTest,
          draft = api.createInitialState();
        const current = draft.pages[draft.currentPageId];
        current.title = "品質確認ノート";
        draft.workspaceName = "LeafNote";
        current.blocks = [
          blk("h2", "いつものノート"),
          blk("text", "画面や操作部品を増やさず、<b>使いやすさ</b>を改善。"),
          blk("todo", "確認済みの項目", { checked: true }),
          blk("text", "改行のある文章<br>続きの文章"),
          blk("table", "", {
            rows: 2,
            cols: 2,
            cells: [
              ["項目", "状態"],
              ["品質", "確認済み"],
            ],
          }),
        ];
        api.setState(draft);
        api.renderAll();
        await document.fonts.ready;
        await _doSave();
        document.activeElement?.blur();
        getSelection().removeAllRanges();
      }),
    );
  }
  assert.equal(dictionaries[0], dictionaries[1]);
  report.unchangedI18n = true;
  for (const width of [320, 768, 1280]) {
    const snapshots = [];
    for (const page of pages) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 850,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        page,
        js(async () => {
          syncSidebarViewportMode();
          scheduleBlockGutterPositions();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }),
      );
      const ui = await evaluate(
        page,
        js(() => ({
          text: document.body.innerText,
          controls: Array.from(
            document.querySelectorAll(
              'button, input, select, textarea, [contenteditable], [role="button"]',
            ),
          ).map((node) => ({
            tag: node.tagName,
            text: node.textContent,
            label: node.getAttribute("aria-label"),
            title: node.title,
            type: node.type,
          })),
          overflow: document.documentElement.scrollWidth > innerWidth,
        })),
      );
      const screenshot = await page.send("Page.captureScreenshot", {
        format: "png",
      });
      snapshots.push({
        ui,
        pixels: hash(Buffer.from(screenshot.data, "base64")),
      });
      if (page === pages[1] && width === 1280)
        await writeFile(
          "/tmp/leafnote-quality-final.png",
          Buffer.from(screenshot.data, "base64"),
        );
    }
    assert.deepEqual(
      snapshots[1],
      snapshots[0],
      `Visual difference at ${width}px`,
    );
    assert.equal(snapshots[1].ui.overflow, false);
    report.viewports.push({
      width,
      unchangedTextControlsPixels: true,
      screenshotSha256: snapshots[1].pixels,
    });
  }

  for (const [index, page] of pages.entries()) {
    const perf = await evaluate(
      page,
      js(() => {
        const api = window.__LeafNoteTest,
          draft = api.createInitialState();
        for (let i = 0; i < 50; i++)
          api.createPage(null, { title: `Note ${i}` });
        api.setState(draft);
        api.renderAll();
        const tree = document.querySelector("#page-tree");
        const observer = new MutationObserver(() => {});
        observer.observe(tree, { childList: true, subtree: true });
        const title = document.querySelector("#page-title");
        title.focus();
        for (let i = 0; i < 20; i++) {
          title.textContent = `Typing ${i}`;
          title.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const records = observer.takeRecords();
        observer.disconnect();
        const rebuiltItems = records.reduce(
          (sum, record) =>
            sum +
            Array.from(record.addedNodes).reduce(
              (count, node) =>
                count + (node.querySelectorAll?.(".page-item").length || 0),
              0,
            ),
          0,
        );
        return { pages: 51, inputs: 20, rebuiltItems };
      }),
    );
    report.performance.push({ source: index ? "after" : "before", ...perf });
  }
  assert.equal(report.performance[1].rebuiltItems, 0);
  assert.ok(
    report.performance[0].rebuiltItems >= report.performance[1].rebuiltItems,
  );

  const page = pages[1];
  await evaluate(
    page,
    js(() => {
      const api = window.__LeafNoteTest,
        draft = api.createInitialState();
      draft.pages[draft.currentPageId].title = "Before";
      api.setState(draft);
      api.renderAll();
      const title = document.querySelector("#page-title");
      title.focus();
      const range = document.createRange();
      range.selectNodeContents(title);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }),
  );
  await page.send("Input.insertText", { text: "After" });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "z",
    code: "KeyZ",
    modifiers: 4,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "z",
    code: "KeyZ",
    modifiers: 4,
  });
  const undo = await evaluate(
    page,
    "({ dom: titleEl.textContent, state: getCurrentPage().title })",
  );
  assert.deepEqual(undo, { dom: "Before", state: "Before" });
  report.native.push({ titleUndo: undo });

  await evaluate(
    page,
    js(() => {
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }),
  );
  await page.send("Input.imeSetComposition", {
    text: "にほんご",
    selectionStart: 4,
    selectionEnd: 4,
  });
  const composing = await evaluate(
    page,
    "({ dom: titleEl.textContent, focused: document.activeElement === titleEl })",
  );
  await page.send("Input.insertText", { text: "日本語" });
  const committed = await evaluate(
    page,
    "({ dom: titleEl.textContent, state: getCurrentPage().title })",
  );
  assert.deepEqual(composing, { dom: "にほんご", focused: true });
  assert.deepEqual(committed, { dom: "日本語", state: "日本語" });
  report.native.push({ ime: { composing, committed } });
  console.log(JSON.stringify(report, null, 2));
  if (process.env.QUALITY_AUDIT_REPORT)
    await writeFile(
      process.env.QUALITY_AUDIT_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
} finally {
  pages.forEach((page) => page.close());
  for (const browser of browsers) {
    await stopBrowser(browser);
    await rm(browser.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
process.exit(0);
