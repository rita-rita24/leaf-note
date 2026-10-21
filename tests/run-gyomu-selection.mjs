import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
  jsWithArgs,
} from "./run-browser.mjs";

const browser = await launchBrowser();
let page;
let failures = 0;
const source = process.env.GYOMU_SOURCE
  ? pathToFileURL(process.env.GYOMU_SOURCE)
  : new URL("../LeafNote.gyomu.html", import.meta.url);
const mouse = (type, x, y, buttons = 0) =>
  page.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    buttons,
    ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }),
  });
const key = async (key, modifiers = 0) => {
  const code = { Delete: 46, Backspace: 8, z: 90 }[key];
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key,
      code: key === "z" ? "KeyZ" : key,
      windowsVirtualKeyCode: code,
      modifiers,
    });
  }
};
const prepare = () =>
  evaluate(
    page,
    js(async () => {
      const draft = createInitialState();
      draft.pages[draft.currentPageId].blocks = [
        blk("text", "最初のブロック"),
        blk("text", "次のブロック"),
        blk("toggle", "折りたたみ", {
          expanded: true,
          children: [blk("text", "子のブロック")],
        }),
        blk("text", "選択しない本文"),
        blk("math", "x + y"),
        blk("code", "const value = 1;", { language: "javascript" }),
      ];
      BlockSelection.clear();
      window.__LeafNoteTest.setState(draft);
      renderAll();
      document.querySelector("#editor-scroll").scrollTop = 0;
      await document.fonts.ready;
      document.activeElement?.blur();
      return structuredClone(getCurrentPage().blocks);
    }),
  );
const focus = (selector) =>
  evaluate(
    page,
    jsWithArgs((selector) => {
      const element = document.querySelector(selector);
      element.focus({ preventScroll: true });
      if (element.isContentEditable) placeCaret(element, "start");
      if (element instanceof HTMLTextAreaElement)
        element.setSelectionRange(0, 0);
    }, selector),
  );
const drag = async (first = 0, last = 1) => {
  const points = await evaluate(
    page,
    jsWithArgs(
      (first, last) => {
        const blocks = [...document.querySelectorAll("#blocks > .block")];
        const a = blocks[first].getBoundingClientRect();
        const b = blocks[last].getBoundingClientRect();
        return {
          start: { x: a.right + 8, y: a.top + 2 },
          end: { x: a.left + 30, y: b.bottom - 2 },
        };
      },
      first,
      last,
    ),
  );
  await mouse("mouseMoved", points.start.x, points.start.y);
  await mouse("mousePressed", points.start.x, points.start.y, 1);
  await mouse("mouseMoved", points.end.x, points.end.y, 1);
  await mouse("mouseReleased", points.end.x, points.end.y);
  return evaluate(page, "BlockSelection.getSelectedIds()");
};
const check = async (name, test) => {
  try {
    await test();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL - ${name}: ${error.message.split("\n")[0]}`);
  }
};

try {
  page = await openPage(browser.port, { url: `${source.href}?test=1` });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 880,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await check(
    "drag selection draws square highlights, including a toggle header",
    async () => {
      const before = await prepare();
      assert.deepEqual(
        await drag(0, 2),
        before.slice(0, 3).map((block) => block.id),
      );
      const radii = await evaluate(
        page,
        js(() =>
          [...document.querySelectorAll(".block.selected")].flatMap((block) => {
            const header = block.querySelector(":scope > .toggle-header");
            return [
              getComputedStyle(block).borderRadius,
              getComputedStyle(header || block, "::after").borderRadius,
            ];
          }),
        ),
      );
      assert.ok(
        radii.every((radius) => radius === "0px"),
        `unexpected radii: ${radii.join(", ")}`,
      );
    },
  );

  for (const [name, selector] of [
    ["textarea", ".raw-block-textarea"],
    ["select", ".code-lang-selector"],
    ["editable text", "#blocks > .block:nth-child(2) > .block-content"],
  ]) {
    for (const deleteKey of ["Delete", "Backspace"]) {
      await check(
        `${deleteKey} deletes the dragged selection after editing ${name}`,
        async () => {
          const before = await prepare();
          await focus(selector);
          assert.deepEqual(
            await drag(),
            before.slice(0, 2).map((block) => block.id),
          );
          await key(deleteKey);
          const after = await evaluate(
            page,
            "structuredClone(getCurrentPage().blocks)",
          );
          assert.deepEqual(
            after,
            before.slice(2),
            "only the selected blocks should be removed",
          );
          assert.equal(
            await evaluate(page, "BlockSelection.hasSelection()"),
            false,
          );
          await key("z", 4);
          assert.deepEqual(
            await evaluate(page, "structuredClone(getCurrentPage().blocks)"),
            before,
            "one undo must restore the whole deletion",
          );
        },
      );
    }
  }

  await check(
    "deleting selected parents removes their children and preserves other blocks",
    async () => {
      const before = await prepare();
      await focus(".raw-block-textarea");
      assert.deepEqual(
        await drag(0, 2),
        before.slice(0, 3).map((block) => block.id),
      );
      await key("Delete");
      assert.deepEqual(
        await evaluate(page, "structuredClone(getCurrentPage().blocks)"),
        before.slice(3),
      );
    },
  );

  await check(
    "deleting every block leaves one editable empty block",
    async () => {
      await prepare();
      await focus(".raw-block-textarea");
      assert.equal((await drag(0, 5)).length, 6);
      await key("Backspace");
      const remaining = await evaluate(
        page,
        "getCurrentPage().blocks.map(({ type, content }) => ({ type, content }))",
      );
      assert.deepEqual(remaining, [{ type: "text", content: "" }]);
    },
  );

  await check(
    "ordinary text deletion still edits the field without deleting its block",
    async () => {
      const before = await prepare();
      await focus(".raw-block-textarea");
      await key("Delete");
      assert.equal(
        await evaluate(page, "getCurrentPage().blocks.length"),
        before.length,
      );
      assert.equal(
        await evaluate(
          page,
          "document.querySelector('.raw-block-textarea').value",
        ),
        " + y",
      );
    },
  );

  await check(
    "clicking back into text cancels block selection before deleting a character",
    async () => {
      const before = await prepare();
      await drag();
      const point = await evaluate(
        page,
        js(() => {
          const rect = document
            .querySelector("#blocks > .block:first-child > .block-content")
            .getBoundingClientRect();
          return { x: rect.x + 3, y: rect.y + rect.height / 2 };
        }),
      );
      await mouse("mousePressed", point.x, point.y, 1);
      await mouse("mouseReleased", point.x, point.y);
      assert.equal(
        await evaluate(page, "BlockSelection.hasSelection()"),
        false,
      );
      await key("Delete");
      assert.equal(
        await evaluate(page, "getCurrentPage().blocks.length"),
        before.length,
      );
    },
  );
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
if (failures) process.exitCode = 1;
