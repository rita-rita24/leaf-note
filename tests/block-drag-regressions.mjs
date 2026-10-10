import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";
import { launchBrowser, stopBrowser } from "./loading-cdp.mjs";
const [source = "leaf-note.html", engine = "chrome", output] =
  process.argv.slice(2);
let owned, browser;
const rows = [];
try {
  if (engine === "chrome") {
    owned = await launchBrowser();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${owned.port}`);
  } else {
    browser = await { firefox, webkit }[engine].launch({ headless: true });
  }
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.goto(
    (source.startsWith("http") ? source : pathToFileURL(resolve(source)).href) +
      "?test=1",
  );
  await page.waitForFunction("window.__LeafNoteTest?.isReady()");
  for (const fixture of [
    "same-before",
    "same-after",
    "numbered",
    "nested",
    "toc",
  ]) {
    const data = await page.evaluate((fixture) => {
      const draft = createInitialState();
      const a = blk(fixture === "numbered" ? "numbered" : "text", "A"),
        b = blk(fixture === "numbered" ? "numbered" : "text", "B"),
        c = blk("text", "C");
      const blocks =
        fixture === "nested"
          ? [a, blk("toggle", "Parent", { expanded: true, children: [b, c] })]
          : [a, b, c];
      if (fixture === "toc") blocks.push(blk("toc", ""));
      draft.pages[draft.currentPageId].blocks = blocks;
      window.__LeafNoteTest.setState(draft);
      renderAll();
      document.querySelector("#editor-scroll").scrollTop = 0;
      window.__dragEvents = [];
      for (const type of ["dragstart", "dragover", "drop", "dragend"])
        document.addEventListener(
          type,
          (e) => window.__dragEvents.push({ type, trusted: e.isTrusted }),
          { once: true, capture: true },
        );
      return {
        a: a.id,
        b: b.id,
        before: JSON.stringify(getCurrentPage().blocks),
        position: fixture === "same-before" ? "before" : "after",
        fixture,
      };
    }, fixture);
    const target = page.locator(`.block[data-id="${data.b}"]`);
    const rect = await target.boundingBox();
    assert.ok(rect);
    await page
      .locator(`.block[data-id="${data.a}"] .block-drag`)
      .dragTo(target, {
        targetPosition: {
          x: Math.min(40, rect.width / 2),
          y: data.position === "before" ? 2 : rect.height - 2,
        },
      });
    const result = await page.evaluate(
      async ({ a, b, position, before, fixture }) => {
        const moved = findBlockAndList(a),
          target = findBlockAndList(b);
        const ids = moved.list.map((x) => x.id),
          ai = ids.indexOf(a),
          bi = ids.indexOf(b);
        const modelOrder =
          moved.list === target.list &&
          ai === bi + (position === "before" ? -1 : 1);
        const element = document.querySelector(blockSelectorById(a)),
          other = document.querySelector(blockSelectorById(b));
        const domOrder =
          position === "before"
            ? element.nextElementSibling === other
            : other.nextElementSibling === element;
        const final = JSON.stringify(getCurrentPage().blocks);
        const dragStateCleared = draggingBlockId === null;
        const immediateMarkersCleared = !document.querySelector(
          "#blocks .drop-above,#blocks .drop-below,#blocks .dragging",
        );
        let nestedFileOnce = true,
          nestedImageOnce = true;
        if (fixture === "nested") {
          const originalFile = _insertFileBlockFromFile,
            originalImage = _insertImageBlockFromFile;
          const calls = [];
          try {
            _insertFileBlockFromFile = (file, block) =>
              calls.push(["file", block.id]);
            _insertImageBlockFromFile = (file, block) =>
              calls.push(["image", block.id]);
            for (const [name, type] of [
              ["a.txt", "text/plain"],
              ["a.png", "image/png"],
            ]) {
              const transfer = new DataTransfer();
              transfer.items.add(new File(["test"], name, { type }));
              other.dispatchEvent(
                new DragEvent("drop", {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer: transfer,
                  clientY: other.getBoundingClientRect().bottom - 1,
                }),
              );
            }
            nestedFileOnce =
              calls.filter(([type]) => type === "file").length === 1 &&
              calls.some(([type, id]) => type === "file" && id === b);
            nestedImageOnce =
              calls.filter(([type]) => type === "image").length === 1 &&
              calls.some(([type, id]) => type === "image" && id === b);
          } finally {
            _insertFileBlockFromFile = originalFile;
            _insertImageBlockFromFile = originalImage;
          }
        }
        undo();
        const undoCorrect = JSON.stringify(getCurrentPage().blocks) === before;
        redo();
        const redoCorrect = JSON.stringify(getCurrentPage().blocks) === final;
        clearTimeout(_saveTimer);
        _saveTimer = null;
        let persisted = false;
        for (let i = 0; i < 100 && !persisted; i++) {
          persisted = await _doSave({ force: true });
          if (!persisted)
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const stored = await loadStateAsync();
        return {
          nestedFileOnce,
          nestedImageOnce,
          dragStateCleared,
          immediateMarkersCleared,
          modelOrder,
          domOrder,
          undoCorrect,
          redoCorrect,
          persisted,
          readback:
            JSON.stringify(stored?.pages[stored.currentPageId].blocks) ===
            final,
          markersCleared: !document.querySelector(
            "#blocks .drop-above,#blocks .drop-below,#blocks .dragging",
          ),
          events: window.__dragEvents,
        };
      },
      data,
    );
    if (output)
      await writeFile(
        output,
        JSON.stringify(
          {
            source,
            engine,
            browser: browser.version(),
            rows: [...rows, { fixture, ...result }],
          },
          null,
          2,
        ),
      );
    for (const key of [
      "nestedFileOnce",
      "nestedImageOnce",
      "dragStateCleared",
      "immediateMarkersCleared",
      "modelOrder",
      "domOrder",
      "undoCorrect",
      "redoCorrect",
      "persisted",
      "readback",
      "markersCleared",
    ])
      assert.equal(result[key], true, fixture + " " + key);
    assert.ok(result.events.some((e) => e.type === "dragstart"));
    assert.ok(result.events.some((e) => e.type === "drop"));
    rows.push({ fixture, ...result });
  }
  if (output)
    await writeFile(
      output,
      JSON.stringify(
        {
          source,
          engine,
          browser: browser.version(),
          date: new Date().toISOString(),
          limits:
            "Browser mouse dragTo on isolated synthetic data; not physical pointer/touch or input latency. Same-list, numbered, nested and TOC plus undo/redo/readback.",
          rows,
        },
        null,
        2,
      ),
    );
  console.log(
    "PASS",
    engine,
    rows.length,
    "browser drags; model/DOM order, undo/redo, final readback",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    if (owned) await stopBrowser(owned);
  }
}
