import assert from "node:assert/strict";
import { APP_PATH } from "../scripts/app-path.mjs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
} from "./run-browser.mjs";

const baselineDir = process.env.QUALITY_BASELINE_DIR;
assert.ok(baselineDir, "Set QUALITY_BASELINE_DIR");
const report = [];
for (const [label, file] of [
  ["before", path.join(baselineDir, "LeafNote.html")],
  ["after", APP_PATH],
]) {
  const browser = await launchBrowser();
  let page;
  try {
    page = await openPage(browser.port, {
      url: `${pathToFileURL(file).href}?test=1`,
    });
    const metrics = await evaluate(
      page,
      js(() => {
        const draft = window.__LeafNoteTest.createInitialState();
        draft.pages[draft.currentPageId].blocks = [
          blk("math", "x"),
          blk("mermaid", "graph TD\nA-->B"),
          blk("html", "<b>text</b>"),
        ];
        window.__LeafNoteTest.setState(draft);
        renderAll();
        return Array.from(document.querySelectorAll(".raw-block")).map(
          (wrap) => {
            const input = wrap.querySelector("textarea"),
              observer = new MutationObserver(() => {});
            observer.observe(wrap, { childList: true });
            for (let i = 0; i < 20; i++)
              input.dispatchEvent(new Event("input", { bubbles: true }));
            const addedNodes = observer
              .takeRecords()
              .reduce((sum, record) => sum + record.addedNodes.length, 0);
            observer.disconnect();
            return {
              type: input.getAttribute("aria-label"),
              inputs: 20,
              addedNodes,
              previews: wrap.children.length - 2,
            };
          },
        );
      }),
    );
    // 合成クリップボードイベントではブラウザ標準の挿入が行われない。
    // ページ側で既定動作を抑止していない場合だけ、CDPの入力でその挿入を補う。
    const paste = await evaluate(
      page,
      js(async () => {
        const draft = window.__LeafNoteTest.createInitialState();
        draft.pages[draft.currentPageId].blocks = [blk("api_spec", "")];
        window.__LeafNoteTest.setState(draft);
        renderAll();
        const target = document.querySelector(".spec-control");
        target.focus();
        target.value = "a".repeat(TEXT_FIELD_MAX_CHARS - 4) + "TAIL";
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.setSelectionRange(2, 2);
        window.__qualityOriginal = target.value;
        const data = new DataTransfer();
        data.setData("text/plain", "overflow");
        const event = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        });
        target.dispatchEvent(event);
        if (!document.querySelector("#dialog-overlay").hidden) hideDialog(true);
        await Promise.resolve();
        return { prevented: event.defaultPrevented };
      }),
    );
    if (!paste.prevented)
      await page.send("Input.insertText", { text: "overflow" });
    Object.assign(
      paste,
      await evaluate(
        page,
        js(() => {
          const target = document.querySelector(".spec-control");
          return {
            intact: target.value === window.__qualityOriginal,
            suffix: target.value.slice(-4),
            stateMatches: getCurrentPage().blocks[0].specTitle === target.value,
          };
        }),
      ),
    );
    await evaluate(
      page,
      js(() => {
        const draft = window.__LeafNoteTest.createInitialState();
        draft.pages[draft.currentPageId].blocks = [blk("math", "base")];
        window.__LeafNoteTest.setState(draft);
        renderAll();
        const input = document.querySelector(".raw-block-textarea");
        input.focus();
        input.select();
        window.__qualityPreview = input.parentElement.lastElementChild;
      }),
    );
    await page.send("Input.imeSetComposition", {
      text: "にほんご",
      selectionStart: 4,
      selectionEnd: 4,
    });
    const composing = await evaluate(
      page,
      js(() => ({
        value: document.querySelector(".raw-block-textarea").value,
        previewUnchanged:
          document.querySelector(".raw-block").lastElementChild ===
          window.__qualityPreview,
      })),
    );
    await page.send("Input.insertText", { text: "日本語" });
    const committed = await evaluate(
      page,
      js(() => ({
        value: document.querySelector(".raw-block-textarea").value,
        state: getCurrentPage().blocks[0].content,
        previews: Array.from(document.querySelectorAll(".raw-block > pre")).map(
          (el) => el.textContent,
        ),
      })),
    );
    const undo = await evaluate(
      page,
      js(async () => {
        const draft = window.__LeafNoteTest.createInitialState();
        draft.pages[draft.currentPageId].blocks = [blk("math", "before after")];
        window.__LeafNoteTest.setState(draft);
        renderAll();
        const target = document.querySelector(".raw-block-textarea");
        target.focus();
        target.setSelectionRange(7, 7);
        const data = new DataTransfer();
        data.setData("text/plain", "pasted ");
        const event = new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        await Promise.resolve();
        return { pasted: target.value };
      }),
    );
    // CDPはOSのショートカット変換を経由しないため、Input.dispatchKeyEventの仕様に従い、
    // 標準の編集コマンドをキーイベントへ明示的に関連付ける。
    for (const type of ["keyDown", "keyUp"])
      await page.send("Input.dispatchKeyEvent", {
        type,
        key: "z",
        code: "KeyZ",
        modifiers: 4,
        ...(type === "keyDown" ? { commands: ["undo"] } : {}),
      });
    Object.assign(
      undo,
      await evaluate(
        page,
        js(() => ({
          value: document.querySelector(".raw-block-textarea").value,
          state: getCurrentPage().blocks[0].content,
        })),
      ),
    );
    const row = {
      source: label,
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
      metrics,
      paste,
      composing,
      committed,
      undo,
    };
    report.push(row);
    if (label === "after") {
      for (const metric of metrics) {
        assert.equal(metric.addedNodes, 0);
        assert.equal(metric.previews, 1);
      }
      assert.deepEqual(paste, {
        prevented: true,
        intact: true,
        suffix: "TAIL",
        stateMatches: true,
      });
      assert.deepEqual(composing, {
        value: "にほんご",
        previewUnchanged: true,
      });
      assert.deepEqual(committed, {
        value: "日本語",
        state: "日本語",
        previews: ["日本語"],
      });
      assert.deepEqual(undo, {
        pasted: "before pasted after",
        value: "before after",
        state: "before after",
      });
    }
  } finally {
    page?.close();
    await stopBrowser(browser);
    await rm(browser.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
console.log(JSON.stringify(report, null, 2));
if (process.env.QUALITY_INPUT_REPORT)
  await writeFile(
    process.env.QUALITY_INPUT_REPORT,
    JSON.stringify(report, null, 2) + "\n",
  );
