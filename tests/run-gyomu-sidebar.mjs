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
const url = process.env.GYOMU_SOURCE
  ? pathToFileURL(process.env.GYOMU_SOURCE)
  : new URL("../LeafNote.gyomu.html", import.meta.url);
const resize = async (width) => {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(page, "new Promise(resolve => setTimeout(resolve, 220))");
};
const mouse = (type, x, y, buttons = type === "mousePressed" ? 1 : 0) =>
  page.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    buttons,
    ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }),
  });
const click = async (selector) => {
  const point = await evaluate(
    page,
    jsWithArgs((selector) => {
      const element = document.querySelector(selector);
      element.scrollIntoView({ block: "nearest" });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, selector),
  );
  await mouse("mouseMoved", point.x, point.y);
  await mouse("mousePressed", point.x, point.y);
  await mouse("mouseReleased", point.x, point.y);
};

try {
  page = await openPage(browser.port, { url: `${url.href}?test=1` });
  await evaluate(
    page,
    js(() => {
      const draft = createInitialState();
      draft.pages[draft.currentPageId].blocks = [
        blk("text", "本文"),
        blk("quote", "引用"),
        blk("callout", "注記"),
        blk("toggle", "折りたたみ", {
          expanded: true,
          children: [blk("text", "子の本文")],
        }),
        blk("code", 'console.log("sample")'),
      ];
      window.__LeafNoteTest.setState(draft);
      renderAll();
      applySidebarWidth(480);
    }),
  );

  for (const width of [1280, 880, 769, 768, 640, 561, 560, 320, 880]) {
    await resize(width);
    const result = await evaluate(
      page,
      js(() => {
        const sidebar = document.querySelector("#sidebar");
        const editor = document.querySelector("#editor-scroll");
        const edge = document.querySelector("#sidebar-resizer");
        const bounds = sidebar.getBoundingClientRect();
        const edgeBounds = edge.getBoundingClientRect();
        const editorBounds = editor.getBoundingClientRect();
        const drawer = SIDEBAR_DRAWER_QUERY.matches;
        return {
          drawer,
          sidebar: bounds.width,
          editor: editorBounds.width,
          edgeVisible: getComputedStyle(edge).display !== "none",
          edgeHit:
            !drawer &&
            document.elementFromPoint(
              edgeBounds.x + edgeBounds.width / 2,
              400,
            ) === edge,
          edgeInsideSidebar: drawer || edgeBounds.right <= bounds.right,
          collapsed: sidebar.classList.contains("collapsed"),
          inert: editor.closest(".main").inert,
          max: Number(edge.getAttribute("aria-valuemax")),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      }),
    );
    assert.equal(result.overflow, false);
    assert.equal(result.inert, false);
    if (width > 560) {
      assert.ok(
        result.editor >= 320,
        `${width}px must leave space for editing`,
      );
      assert.equal(
        result.edgeVisible,
        true,
        `${width}px resize handle must stay available`,
      );
      assert.equal(result.edgeHit, true);
      assert.equal(result.edgeInsideSidebar, true);
      assert.equal(result.sidebar, Math.min(480, width - 320));
      assert.equal(result.max, Math.min(480, width - 320));
    } else {
      assert.equal(result.collapsed, true);
    }
    const gutters = await evaluate(
      page,
      js(() => {
        const viewport = document
          .querySelector("#editor-scroll")
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll(".block-gutter-btn:not(.block-drag)"),
        ].map((button) => {
          button.scrollIntoView({ block: "nearest" });
          const rect = button.getBoundingClientRect();
          return {
            type: button.closest(".block").dataset.type,
            inside: rect.left >= viewport.left && rect.right <= viewport.right,
            hit: button.contains(
              document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              ),
            ),
          };
        });
      }),
    );
    for (const gutter of gutters) {
      assert.ok(
        gutter.inside && gutter.hit,
        `${width}px ${gutter.type} add button is covered or clipped`,
      );
    }
    console.log(
      `ok - ${width}px: resize handle and all add buttons are reachable`,
    );
  }

  await resize(640);
  await evaluate(page, "applySidebarWidth(260)");
  const start = await evaluate(
    page,
    js(() => {
      const rect = document
        .querySelector("#sidebar-resizer")
        .getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: 400 };
    }),
  );
  await mouse("mouseMoved", start.x, start.y);
  await mouse("mousePressed", start.x, start.y);
  await mouse("mouseMoved", start.x + 40, start.y, 1);
  await mouse("mouseReleased", start.x + 40, start.y);
  assert.equal(
    await evaluate(
      page,
      "document.querySelector('#sidebar').getBoundingClientRect().width",
    ),
    300,
  );
  assert.equal(
    await evaluate(
      page,
      "document.querySelector('#sidebar').classList.contains('resizing')",
    ),
    false,
  );
  await evaluate(page, "document.querySelector('#sidebar-resizer').focus()");
  for (const [key, expected] of [
    ["ArrowLeft", 292],
    ["Home", 180],
    ["End", 320],
  ]) {
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
    });
    assert.equal(
      await evaluate(
        page,
        "document.querySelector('#sidebar').getBoundingClientRect().width",
      ),
      expected,
    );
  }
  console.log(
    "ok - real pointer dragging and keyboard resizing work in a narrow split layout",
  );

  const before = await evaluate(page, "getCurrentPage().blocks.length");
  await click(".block-gutter-btn:not(.block-drag)");
  assert.equal(
    await evaluate(page, "document.querySelector('#context-menu').hidden"),
    false,
  );
  await click("#context-menu .ctx-item");
  assert.equal(
    await evaluate(page, "getCurrentPage().blocks.length"),
    before + 1,
  );
  console.log(
    "ok - clicking the visible add button opens the menu and inserts a block",
  );

  await resize(320);
  await click("#sidebar-open");
  await evaluate(page, "new Promise(resolve => setTimeout(resolve, 220))");
  assert.equal(
    await evaluate(page, "document.querySelector('.main').inert"),
    true,
  );
  await click("#sidebar-toggle");
  await evaluate(page, "new Promise(resolve => setTimeout(resolve, 220))");
  assert.equal(
    await evaluate(page, "document.querySelector('.main').inert"),
    false,
  );
  await click(".block-gutter-btn:not(.block-drag)");
  assert.equal(
    await evaluate(page, "document.querySelector('#context-menu').hidden"),
    false,
  );
  console.log(
    "ok - after closing the mobile drawer, the editor add button is immediately usable",
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
