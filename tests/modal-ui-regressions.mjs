import assert from "node:assert/strict";
import { evaluate, js, jsWithArgs } from "./run-browser.mjs";

const openModal = async (page, name) => {
  await evaluate(
    page,
    jsWithArgs((name) => {
      window.__modalResult = "pending";
      const trigger =
        innerWidth <= 560
          ? document.querySelector("#sidebar-open")
          : document.querySelector("#settings-btn");
      trigger.focus();
      window.__modalTrigger = trigger;
      let pending;
      switch (name) {
        case "search":
          openSearchModal();
          break;
        case "theme":
          openThemeCustomizer();
          break;
        case "trash":
          openTrashModal();
          break;
        case "shortcuts":
          openShortcutsModal();
          break;
        case "alert":
          pending = showAlert("保存結果 / Save result");
          break;
        case "confirm":
          pending = showConfirm("削除しますか / Delete?", { danger: true });
          break;
        case "prompt":
          pending = showPrompt("URLを入力 / Enter URL", {
            defaultValue: "https://example.com",
          });
          break;
        case "save":
          pending = showSaveDocumentDialog();
          break;
        case "long":
          pending = showAlert("長い説明 / Long content. ".repeat(180), {
            title: "長い見出し / Long title ".repeat(4),
          });
          break;
      }
      pending?.then((result) => {
        window.__modalResult = result;
      });
    }, name),
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
};

const key = async (page, name, code, modifiers = 0) => {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: name,
    code: name,
    windowsVirtualKeyCode: code,
    modifiers,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: name,
    code: name,
    windowsVirtualKeyCode: code,
    modifiers,
  });
};

export async function verifyModalUI(page, ok) {
  const names = [
    "search",
    "theme",
    "trash",
    "shortcuts",
    "alert",
    "confirm",
    "prompt",
    "save",
    "long",
  ];
  for (const [width, height, language, dark] of [
    [1280, 900, "ja", false],
    [320, 568, "ja", false],
    [768, 500, "en", false],
    [1280, 900, "en", true],
    [320, 568, "en", true],
  ]) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      page,
      jsWithArgs(
        ({ language, dark }) => {
          hideDialog(null);
          qsa(".overlay").forEach(closeOverlay);
          const draft = window.__LeafNoteTest.createInitialState();
          draft.uiLanguage = language;
          draft.darkMode = dark;
          window.__LeafNoteTest.setState(draft);
          applyLanguage();
          applyTheme();
          renderAll();
          setSidebarCollapsed(innerWidth <= 560);
          const removed = createPage(null, {
            title: "削除済み / Deleted note",
          });
          deletePage(removed.id);
        },
        { language, dark },
      ),
    );
    for (const name of names) {
      await openModal(page, name);
      const result = await evaluate(
        page,
        jsWithArgs((name) => {
          const overlay = getTopOpenOverlay();
          const modal = overlay.querySelector('[role="dialog"]');
          const rect = modal.getBoundingClientRect();
          const closeButtons = modal.querySelectorAll(".overlay-close");
          const close = closeButtons[0];
          const closeRect = close?.getBoundingClientRect();
          const inView = (r) =>
            r &&
            r.left >= 0 &&
            r.top >= 0 &&
            r.right <= innerWidth &&
            r.bottom <= innerHeight;
          const body = modal.querySelector(".modal-body");
          const expected = {
            search: "#search-input",
            theme: "#ui-language-select",
            trash: "#trash-close-btn",
            shortcuts: "#shortcuts-close-btn",
            alert: "[data-ok]",
            confirm: "[data-cancel]",
            prompt: ".dialog-input",
            save: ".dialog-input",
            long: "[data-ok]",
          }[name];
          const before = close?.getBoundingClientRect().y;
          body.scrollTop = body.scrollHeight;
          return {
            closeCount: closeButtons.length,
            named: !!close?.getAttribute("aria-label"),
            visible: inView(rect) && inView(closeRect),
            noOverflow: modal.scrollWidth <= modal.clientWidth,
            initialFocus: document.activeElement.matches(expected),
            backgroundInert: document.querySelector(".app").inert,
            fixedHeader:
              before === close?.getBoundingClientRect().y &&
              modal.scrollTop === 0,
            footerVisible: [
              ...modal.querySelectorAll(".modal-footer button"),
            ].every((el) => inView(el.getBoundingClientRect())),
            label:
              modal.getAttribute("aria-label") ||
              document
                .getElementById(modal.getAttribute("aria-labelledby"))
                ?.textContent.trim(),
          };
        }, name),
      );
      assert.equal(result.closeCount, 1, name);
      assert.ok(result.label, name);
      for (const [property, value] of Object.entries(result)) {
        if (!["label", "closeCount"].includes(property))
          assert.equal(
            value,
            true,
            `${name}/${width}/${language}: ${property}`,
          );
      }
      const ax = await page.send("Accessibility.getFullAXTree");
      const unnamed = ax.nodes.filter(
        (node) =>
          !node.ignored &&
          ["button", "textbox", "searchbox", "combobox"].includes(
            node.role?.value,
          ) &&
          !node.name?.value,
      );
      assert.deepEqual(unnamed, [], `${name}: unlabeled control`);
      await evaluate(
        page,
        "getFocusableElements(getTopOpenOverlay()).at(-1).focus()",
      );
      await key(page, "Tab", 9);
      assert.equal(
        await evaluate(
          page,
          "document.activeElement === getFocusableElements(getTopOpenOverlay())[0]",
        ),
        true,
        `${name}: Tab wraps`,
      );
      await key(page, "Tab", 9, 8);
      assert.equal(
        await evaluate(
          page,
          "document.activeElement === getFocusableElements(getTopOpenOverlay()).at(-1)",
        ),
        true,
        `${name}: Shift+Tab wraps`,
      );
      await evaluate(
        page,
        'getTopOpenOverlay().querySelector(".overlay-close").click()',
      );
      assert.equal(
        await evaluate(
          page,
          '!getTopOpenOverlay() && !document.querySelector(".app").inert && document.activeElement === window.__modalTrigger',
        ),
        true,
        `${name}: close restores focus`,
      );
      if (["alert", "confirm", "prompt", "save", "long"].includes(name))
        assert.equal(
          await evaluate(page, "window.__modalResult"),
          null,
          `${name}: close cancels`,
        );
      ok(
        `LeafNote: ${name} modal / ${width}×${height} / ${language} / ${dark ? "dark" : "light"}`,
      );
    }
  }

  for (const name of names.slice(0, -1)) {
    await openModal(page, name);
    await key(page, "Escape", 27);
    assert.equal(
      await evaluate(
        page,
        "!getTopOpenOverlay() && document.activeElement === window.__modalTrigger",
      ),
      true,
      `${name}: Escape restores focus`,
    );
    await openModal(page, name);
    const start = await evaluate(
      page,
      js(() => {
        const r = getTopOpenOverlay()
          .querySelector(".modal-header")
          .getBoundingClientRect();
        return { x: r.x + 8, y: r.y + 8 };
      }),
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...start,
      button: "left",
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 2,
      y: 2,
      button: "left",
      buttons: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 2,
      y: 2,
      button: "left",
      clickCount: 1,
    });
    assert.equal(
      await evaluate(page, "!!getTopOpenOverlay()"),
      true,
      `${name}: dragging outside must not dismiss`,
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 2,
      y: 2,
      button: "left",
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 2,
      y: 2,
      button: "left",
      clickCount: 1,
    });
    assert.equal(
      await evaluate(
        page,
        "!getTopOpenOverlay() && document.activeElement === window.__modalTrigger",
      ),
      true,
      `${name}: backdrop click restores focus`,
    );
  }
  ok(
    "LeafNote: all modal types support Escape and backdrop clicks without dismissing on a drag",
  );

  await openModal(page, "theme");
  await evaluate(
    page,
    'document.querySelector("#theme-reset-btn").focus(); document.querySelector("#theme-reset-btn").click()',
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  await evaluate(
    page,
    'document.querySelector("#dialog-box .overlay-close").click()',
  );
  assert.equal(
    await evaluate(
      page,
      '!document.querySelector("#theme-customizer-overlay").hidden && document.querySelector("#dialog-overlay").hidden && document.activeElement.id === "theme-reset-btn" && document.querySelector(".app").inert',
    ),
    true,
  );
  await key(page, "Escape", 27);
  ok(
    "LeafNote: nested confirmation closes independently and restores its invoking button",
  );
  await evaluate(
    page,
    "delete window.__modalResult; delete window.__modalTrigger",
  );
}
