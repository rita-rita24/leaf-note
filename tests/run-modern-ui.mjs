import assert from "node:assert/strict";
import { APP_FILE_NAME } from "../scripts/app-path.mjs";
import { rm, writeFile } from "node:fs/promises";
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
import { verifyModalUI } from "./modal-ui-regressions.mjs";

const root = path.resolve(import.meta.dirname, "..");
const browser = await launchBrowser();
const baselineBrowser = process.env.MODERN_UI_BASELINE
  ? await launchBrowser()
  : null;
const pages = [];
let passed = 0;
const ok = (message) => {
  passed++;
  console.log(`ok - ${message}`);
};

const prepare = async (page, darkMode) =>
  evaluate(
    page,
    jsWithArgs(async (dark) => {
      if (window.__LeafNoteTest) {
        const api = window.__LeafNoteTest;
        const draft = api.createInitialState();
        draft.darkMode = dark;
        draft.workspaceName = "UI verification";
        const note = draft.pages[draft.currentPageId];
        note.title = "表示・入力の確認";
        note.blocks = [
          api.blk("h2", "見出しと本文"),
          api.blk("text", "日本語と English、<b>太字</b>。"),
          api.blk("todo", "チェック項目", { checked: true }),
          api.blk("code", "const value = 1;", { language: "javascript" }),
          api.blk("table", "", {
            rows: 2,
            cols: 2,
            cells: [
              ["項目", "状態"],
              ["テスト", "確認"],
            ],
            hasHeaderRow: true,
          }),
          api.blk("callout", "補足"),
          api.blk("math", "x + y"),
          ...[
            "decision",
            "requirement",
            "open_question",
            "risk",
            "api_spec",
            "db_table",
            "screen_spec",
            "test_case",
          ].map((type) => api.blk(type, "")),
        ];
        note.blocks.forEach((block, index) => {
          block.id = `ui-${index}`;
        });
        api.setState(draft);
        api.internals.applyTheme();
        api.renderAll();
        setSidebarCollapsed(innerWidth <= 560);
      }
      await document.fonts.ready;
      document.activeElement?.blur();
      getSelection().removeAllRanges();
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (window.__LeafNoteTest) updateBlockGutterPositions();
    }, darkMode),
  );

const snapshot = () =>
  [...document.body.querySelectorAll("*")]
    .filter(
      (element) =>
        !element.closest("script, style") && element.getClientRects().length,
    )
    .map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const properties = [
        "display",
        "color",
        "backgroundColor",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "padding",
        "margin",
        "borderRadius",
        "borderTopWidth",
        "borderTopColor",
      ];
      return {
        tag: element.tagName,
        id: element.id,
        class: element.className,
        rect: [rect.x, rect.y, rect.width, rect.height].map(
          (value) => Math.round(value * 100) / 100,
        ),
        styles: Object.fromEntries(properties.map((key) => [key, style[key]])),
      };
    });

try {
  for (const file of [APP_FILE_NAME, "index.html"]) {
    const readyExpression =
      file === "index.html"
        ? "window.__LeafNoteIndexReady === true"
        : undefined;
    const page = await openPage(browser.port, {
      url: `${pathToFileURL(path.join(root, file))}?test=1`,
      readyExpression,
    });
    pages.push(page);
    let baseline;
    if (process.env.MODERN_UI_BASELINE) {
      const baselineName =
        file === APP_FILE_NAME
          ? process.env.MODERN_UI_BASELINE_APP || "LeafNote.html"
          : file;
      baseline = await openPage(baselineBrowser.port, {
        url: `${pathToFileURL(path.join(process.env.MODERN_UI_BASELINE, baselineName))}?test=1`,
        readyExpression,
      });
      pages.push(baseline);
    }
    for (const width of [320, 768, 1280]) {
      for (const dark of file === "index.html" ? [false] : [false, true]) {
        for (const target of [page, baseline].filter(Boolean)) {
          await target.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await prepare(target, dark);
        }
        assert.equal(
          await evaluate(
            page,
            "document.documentElement.scrollWidth > innerWidth",
          ),
          false,
          `${file}: horizontal overflow at ${width}`,
        );
        if (baseline)
          assert.deepEqual(
            await evaluate(page, js(snapshot)),
            await evaluate(baseline, js(snapshot)),
            `${file}: layout or palette changed at ${width}/${dark}`,
          );
        ok(`${file}: layout at ${width}px / ${dark ? "dark" : "light"}`);
      }
    }
    if (file === APP_FILE_NAME) {
      for (const [width, height, touch] of [
        [320, 568, true],
        [768, 500, false],
        [1280, 500, false],
      ]) {
        await page.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: touch,
        });
        await page.send("Emulation.setTouchEmulationEnabled", {
          enabled: touch,
        });
        await prepare(page, false);
        await evaluate(
          page,
          "setSidebarCollapsed(false); new Promise(resolve => setTimeout(resolve, 200))",
        );
        const layout = await evaluate(
          page,
          js(() => ({
            controls: [...document.querySelectorAll(".sidebar-nav-item")].map(
              (element) => {
                const rect = element.getBoundingClientRect();
                return {
                  id: element.id,
                  top: rect.top,
                  bottom: rect.bottom,
                  height: rect.height,
                };
              },
            ),
            treeHeight: document
              .querySelector("#page-tree")
              .getBoundingClientRect().height,
            targets: [
              ...document.querySelectorAll(
                ".block-gutter-btn, .page-item-action, .page-item-chevron:not(:disabled)",
              ),
            ].map((element) => {
              const rect = element.getBoundingClientRect();
              return { width: rect.width, height: rect.height };
            }),
          })),
        );
        for (const control of layout.controls) {
          assert.ok(
            control.top >= 0 && control.bottom <= height,
            `${control.id} outside ${width}×${height}`,
          );
          assert.ok(control.height >= 24);
        }
        assert.ok(
          layout.treeHeight >= 70,
          "note navigation must remain usable",
        );
        for (const target of layout.targets)
          assert.ok(target.width >= 24 && target.height >= 24);
        ok(
          `LeafNote: sidebar actions and menu targets fit ${width}×${height} / touch ${touch}`,
        );
      }
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const dark of file === "index.html" ? [false] : [false, true]) {
      await prepare(page, dark);
      for (const forced of [false, true]) {
        await page.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "forced-colors", value: forced ? "active" : "none" },
          ],
        });
        await page.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await page.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        const results = await evaluate(
          page,
          js(() => {
            const targets = [
              ...document.querySelectorAll(
                'button, a[href], input, select, textarea, [contenteditable="true"], [tabindex="0"]',
              ),
            ].filter(
              (el) =>
                !el.disabled &&
                !el.closest("[hidden], [inert]") &&
                el.getClientRects().length,
            );
            return targets.map((el) => {
              const before = el.getBoundingClientRect();
              el.focus({ preventScroll: true });
              const after = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return {
                target: el.id || el.className,
                focused: document.activeElement === el,
                visible: el.matches(":focus-visible"),
                style: style.outlineStyle,
                width: parseFloat(style.outlineWidth),
                offset: parseFloat(style.outlineOffset),
                shadow: style.boxShadow,
                color: style.outlineColor,
                stable:
                  before.width === after.width &&
                  before.height === after.height,
              };
            });
          }),
        );
        assert.ok(results.length > 0);
        for (const result of results) {
          assert.equal(result.focused, true, result.target);
          assert.equal(result.visible, true, result.target);
          assert.equal(result.style, "solid", result.target);
          assert.ok(
            result.width >= 2 && result.offset <= -result.width,
            `${result.target}: focus extends outside: ${JSON.stringify(result)}`,
          );
          assert.equal(
            result.shadow,
            "none",
            `${result.target}: duplicate focus shadow`,
          );
          assert.equal(
            result.stable,
            true,
            `${result.target}: focus changes layout`,
          );
          assert.notEqual(
            result.color,
            "rgba(0, 0, 0, 0)",
            `${result.target}: invisible focus`,
          );
        }
        ok(
          `${file}: ${results.length} keyboard targets / ${dark ? "dark" : "light"} / forced colors ${forced}`,
        );
        if (file === APP_FILE_NAME) {
          const controls = await evaluate(
            page,
            js(() =>
              [...document.querySelectorAll('select, input[type="date"]')].map(
                (el) => {
                  const style = getComputedStyle(el);
                  return {
                    name:
                      el.id || el.getAttribute("aria-label") || el.className,
                    appearance: style.appearance,
                    backgroundImage: style.backgroundImage,
                  };
                },
              ),
            ),
          );
          assert.ok(controls.length > 0);
          for (const control of controls) {
            assert.ok(
              control.appearance !== "none" ||
                (!forced && control.backgroundImage !== "none"),
              `${control.name}: control indicator is hidden`,
            );
          }
          ok(
            `LeafNote: select and date indicators / ${dark ? "dark" : "light"} / forced colors ${forced}`,
          );
        }
      }
    }
    await page.send("Emulation.setEmulatedMedia", { features: [] });
    if (file === APP_FILE_NAME) {
      const signals = await evaluate(
        page,
        '[null, undefined, "", 42].map(value => [looksLikeMarkdown(value), looksLikeMarkdownBlockPaste(value), looksLikeMarkdownInlineOnly(value)])',
      );
      assert.deepEqual(
        signals,
        Array.from({ length: 4 }, () => [false, false, false]),
      );
      await evaluate(page, "setSidebarCollapsed(true)");
      assert.equal(
        await evaluate(page, 'document.querySelector("#sidebar-open").hidden'),
        false,
      );
      await evaluate(page, "setSidebarCollapsed(false)");
      assert.equal(
        await evaluate(
          page,
          'getComputedStyle(document.querySelector("#sidebar-open")).display',
        ),
        "none",
      );
      ok("LeafNote: invalid Markdown input and sidebar hidden state");
      await evaluate(page, 'document.querySelector("#settings-btn").click()');
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const selector of ["#ui-language-select", "#theme-done-btn"]) {
        const result = await evaluate(
          page,
          jsWithArgs((selector) => {
            const el = document.querySelector(selector);
            el.focus();
            const style = getComputedStyle(el);
            return {
              width: parseFloat(style.outlineWidth),
              offset: parseFloat(style.outlineOffset),
              shadow: style.boxShadow,
              appearance: style.appearance,
              backgroundImage: style.backgroundImage,
            };
          }, selector),
        );
        assert.ok(result.width >= 2 && result.offset <= -result.width);
        assert.equal(result.shadow, "none");
        if (selector === "#ui-language-select")
          assert.ok(
            result.appearance !== "none" || result.backgroundImage !== "none",
          );
      }
      ok("LeafNote: modal controls retain inner focus");
      const colorPicker = await evaluate(
        page,
        'getComputedStyle(document.querySelector(".theme-color-picker")).appearance',
      );
      assert.notEqual(
        colorPicker,
        "none",
        "custom accent must retain its native color picker",
      );
      for (const expected of ["en", "ja"]) {
        const result = await evaluate(
          page,
          jsWithArgs((language) => {
            const select = document.querySelector("#ui-language-select");
            select.focus();
            const intercepted = ["ArrowUp", "ArrowDown", "Home", "End"].filter(
              (key) => {
                const event = new KeyboardEvent("keydown", {
                  key,
                  bubbles: true,
                  cancelable: true,
                });
                select.dispatchEvent(event);
                return event.defaultPrevented;
              },
            );
            select.value = language;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return {
              intercepted,
              language: window.__LeafNoteTest.getState().uiLanguage,
              documentLanguage: document.documentElement.lang,
            };
          }, expected),
        );
        assert.deepEqual(result, {
          intercepted: [],
          language: expected,
          documentLanguage: expected,
        });
      }
      ok(
        "LeafNote: language changes update the UI and navigation keys remain available to the select",
      );
      await verifyModalUI(page, ok);
    }
    if (process.env.MODERN_UI_SCREENSHOTS) {
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      await writeFile(
        path.join(process.env.MODERN_UI_SCREENSHOTS, `${file}.png`),
        Buffer.from(shot.data, "base64"),
      );
    }
  }
  console.log(`Passed ${passed} UI checks.`);
} finally {
  for (const page of pages) page.close();
  await stopBrowser(browser);
  await rm(browser.userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  if (baselineBrowser) {
    await stopBrowser(baselineBrowser);
    await rm(baselineBrowser.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
