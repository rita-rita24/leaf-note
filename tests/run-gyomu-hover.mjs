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
const first = "#blocks > .block:first-child";
const parent = '#blocks > .block[data-type="toggle"]';
const child = `${parent} .toggle-children > .block`;
const settle = () =>
  evaluate(page, "new Promise(resolve => setTimeout(resolve, 300))");
const mouse = (type, x, y) =>
  page.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }),
  });
const pointAt = (selector) =>
  evaluate(
    page,
    jsWithArgs((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, selector),
  );
const hover = async (selector) => {
  const { x, y } = await pointAt(selector);
  await mouse("mouseMoved", x, y);
  await settle();
};
const click = async (selector) => {
  const { x, y } = await pointAt(selector);
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
};
const outside = async () => {
  await mouse("mouseMoved", 20, 800);
  await settle();
};
const key = async (key, modifiers = 0) => {
  const windowsVirtualKeyCode = {
    Tab: 9,
    Enter: 13,
    Escape: 27,
    ArrowDown: 40,
  }[key];
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code: key,
    modifiers,
    windowsVirtualKeyCode,
    ...(key === "Enter" ? { text: "\r" } : {}),
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: key,
    modifiers,
    windowsVirtualKeyCode,
  });
};
const gutter = (selector) =>
  evaluate(
    page,
    jsWithArgs((selector) => {
      const block = document.querySelector(selector);
      const gutter = block.querySelector(
        ":scope > .block-gutter, :scope > .toggle-header > .block-gutter",
      );
      return Number(getComputedStyle(gutter).opacity);
    }, selector),
  );
const check = async (name, test) => {
  try {
    await test();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL - ${name}: ${error.message}`);
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
  await evaluate(
    page,
    js(async () => {
      const draft = createInitialState();
      draft.pages[draft.currentPageId].blocks = [
        blk("text", "ホバー確認"),
        blk("toggle", "親ブロック", {
          expanded: true,
          children: [blk("text", "子ブロック")],
        }),
      ];
      window.__LeafNoteTest.setState(draft);
      renderAll();
      await document.fonts.ready;
      document.activeElement?.blur();
    }),
  );
  await outside();

  await check(
    "pointer hover reveals the gutter and leaving hides it",
    async () => {
      assert.equal(await gutter(first), 0);
      await hover(`${first} > .block-content`);
      assert.equal(await gutter(first), 1);
      await outside();
      assert.equal(await gutter(first), 0);
    },
  );

  await check(
    "click focus does not leave the drag handle visible outside its block",
    async () => {
      await click(`${first} .block-drag`);
      await outside();
      const focus = await evaluate(
        page,
        js(() => ({
          mouseFocus: document.activeElement.matches(
            ".block-drag:focus:not(:focus-visible)",
          ),
          menuOpen: !document.querySelector("#context-menu").hidden,
        })),
      );
      assert.equal(focus.mouseFocus, true);
      assert.equal(
        focus.menuOpen,
        true,
        "a clicked menu stays open when the pointer leaves",
      );
      assert.equal(await gutter(first), 0);
    },
  );
  await check(
    "clicking outside dismisses the opened context menu",
    async () => {
      await click(`${first} .block-drag`);
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        false,
      );
      await mouse("mousePressed", 20, 800);
      await mouse("mouseReleased", 20, 800);
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        true,
      );
    },
  );

  await check(
    "hovering a nested child does not show the parent gutter",
    async () => {
      await hover(`${child} > .block-content`);
      assert.equal(await gutter(child), 1);
      assert.equal(await gutter(parent), 0);
      await hover(`${parent} > .toggle-header > .block-content`);
      assert.equal(await gutter(parent), 1);
      assert.equal(await gutter(child), 0);
      await hover(`${parent} > .toggle-header .block-drag`);
      assert.equal(
        await gutter(parent),
        1,
        "moving from the heading to its handle must keep it available",
      );
    },
  );

  await check(
    "keyboard navigation reveals and activates the add button",
    async () => {
      await outside();
      await evaluate(
        page,
        jsWithArgs(
          (selector) => document.querySelector(selector).focus(),
          `${first} > .block-content`,
        ),
      );
      await key("Tab", 8);
      await key("Tab", 8);
      await settle();
      assert.equal(
        await evaluate(
          page,
          "document.activeElement.matches('.block-gutter-btn:not(.block-drag):focus-visible')",
        ),
        true,
      );
      assert.equal(await gutter(first), 1);
      await key("Enter");
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        false,
      );
      await evaluate(page, "hideContextMenu(); document.activeElement.blur()");
      await settle();
      assert.equal(await gutter(first), 0);
    },
  );

  await check(
    "moving from the trigger into the menu keeps items clickable",
    async () => {
      await click(`${first} .block-drag`);
      // Cross the small gap without waiting for the leave grace period.
      const trigger = await pointAt(`${first} .block-drag`);
      await mouse("mouseMoved", trigger.x + 28, trigger.y);
      await hover("#context-menu .ctx-item");
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        false,
      );
      const count = await evaluate(page, "getCurrentPage().blocks.length");
      await click("#context-menu .ctx-item");
      assert.equal(
        await evaluate(page, "getCurrentPage().blocks.length"),
        count + 1,
      );
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        true,
      );
    },
  );

  await check(
    "continuous pointer movement outside retains a clicked menu",
    async () => {
      await click(`${first} .block-drag`);
      for (let step = 0; step < 8; step++) {
        await mouse("mouseMoved", 20 + step, 800);
        await evaluate(page, "new Promise(resolve => setTimeout(resolve, 40))");
      }
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        false,
      );
    },
  );

  await check(
    "switching from keyboard to pointer hides the old focused gutter",
    async () => {
      await outside();
      await evaluate(
        page,
        jsWithArgs(
          (selector) => document.querySelector(selector).focus(),
          `${first} > .block-content`,
        ),
      );
      await key("Tab", 8);
      await key("Tab", 8);
      await settle();
      assert.equal(await gutter(first), 1);
      await hover(`${parent} > .toggle-header > .block-content`);
      assert.equal(await gutter(first), 0);
      assert.equal(await gutter(parent), 1);
    },
  );

  await check(
    "Escape closes a clicked menu without selecting or changing a block",
    async () => {
      await click(`${first} .block-drag`);
      await key("Escape");
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        true,
      );
      assert.equal(
        await evaluate(page, "document.activeElement.matches('.block-drag')"),
        true,
      );
    },
  );

  await check(
    "menu scrolling stays open but editor scrolling dismisses it",
    async () => {
      await click(`${first} .block-drag`);
      await evaluate(
        page,
        "document.querySelector('#context-menu').dispatchEvent(new Event('scroll'))",
      );
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        false,
      );
      await evaluate(
        page,
        "document.querySelector('#editor-scroll').dispatchEvent(new Event('scroll'))",
      );
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        true,
      );
    },
  );

  await check(
    "leaving the web view clears hover and retains a clicked menu",
    async () => {
      await click(`${first} .block-drag`);
      await evaluate(
        page,
        "document.documentElement.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))",
      );
      await settle();
      assert.equal(await gutter(first), 0);
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        false,
      );
    },
  );

  await check("losing window focus clears transient controls", async () => {
    await click(`${first} .block-drag`);
    await evaluate(page, "window.dispatchEvent(new Event('blur'))");
    await settle();
    assert.equal(await gutter(first), 0);
    assert.equal(
      await evaluate(page, "document.querySelector('#context-menu').hidden"),
      true,
    );
  });

  await check("editor rebuilds discard old menu actions", async () => {
    await click(`${first} .block-drag`);
    await evaluate(page, "renderEditor()");
    assert.equal(
      await evaluate(page, "document.querySelector('#context-menu').hidden"),
      true,
    );
  });

  await check(
    "a modal opened by a shortcut does not leave a menu above it",
    async () => {
      await click(`${first} .block-drag`);
      await evaluate(page, "openSearchModal()");
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        true,
      );
    },
  );
  await evaluate(page, "closeSearchModal()");
  await outside();

  await check("closing a slash picker resets its input state", async () => {
    await evaluate(
      page,
      jsWithArgs((selector) => {
        const content = document.querySelector(`${selector} > .block-content`);
        showSlashMenu(content, getCurrentPage().blocks[0]);
        hideContextMenu();
      }, first),
    );
    assert.equal(await evaluate(page, "slashOpen"), false);
    assert.equal(await evaluate(page, "slashBlock"), null);
  });

  await check(
    "keyboard arrow and Enter still insert a block from the add menu",
    async () => {
      const count = await evaluate(page, "getCurrentPage().blocks.length");
      await click(`${first} .block-gutter-btn:not(.block-drag)`);
      await key("ArrowDown");
      assert.equal(
        await evaluate(
          page,
          "document.activeElement.matches('#context-menu .ctx-item')",
        ),
        true,
      );
      await key("Enter");
      assert.equal(
        await evaluate(page, "getCurrentPage().blocks.length"),
        count + 1,
      );
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        true,
      );
    },
  );

  await check(
    "dragging closes the menu and still reorders blocks",
    async () => {
      await click(`${first} .block-drag`);
      const result = await evaluate(
        page,
        jsWithArgs((selector) => {
          const source = document.querySelector(`${selector} .block-drag`);
          const id = source.closest(".block").dataset.id;
          const target = document.querySelector("#blocks > .block:last-child");
          const dataTransfer = new DataTransfer();
          source.dispatchEvent(
            new DragEvent("dragstart", { bubbles: true, dataTransfer }),
          );
          const menuClosed = document.querySelector("#context-menu").hidden;
          const rect = target.getBoundingClientRect();
          target.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer,
              clientY: rect.bottom - 1,
            }),
          );
          source.dispatchEvent(
            new DragEvent("dragend", { bubbles: true, dataTransfer }),
          );
          return {
            menuClosed,
            moved: getCurrentPage().blocks.at(-1).id === id,
            cleaned: draggingBlockId === null,
          };
        }, first),
      );
      assert.deepEqual(result, {
        menuClosed: true,
        moved: true,
        cleaned: true,
      });
    },
  );

  await check(
    "touch devices keep all gutter controls discoverable",
    async () => {
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await outside();
      assert.equal(
        await evaluate(page, "matchMedia('(hover: none)').matches"),
        true,
      );
      for (const selector of [first, parent, child])
        assert.equal(await gutter(selector), 1);
    },
  );

  await check(
    "a touch-opened menu stays usable after lifting the finger",
    async () => {
      const { x, y } = await pointAt(`${first} .block-drag`);
      await page.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 0 }],
      });
      await page.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await settle();
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        false,
      );
      await page.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 20, y: 800, id: 0 }],
      });
      await page.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      assert.equal(
        await evaluate(page, "document.querySelector('#context-menu').hidden"),
        true,
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
