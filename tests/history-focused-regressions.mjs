import assert from "node:assert/strict";
import { openTestPage } from "./test-page.mjs";
const [source = "LeafNote.html", engine = "chrome"] = process.argv.slice(2);
const page = await openTestPage({
  source,
  engine,
  ready: "window.__LeafNoteTest?.isReady()",
});
try {
  console.log("Browser:", engine, page.version);
  for (let trial = 0; trial < 5; trial++) {
    const results = await page.evaluate(async () => {
      const api = window.__LeafNoteTest;
      const results = [];
      for (const selector of ["#page-title", "#document-name"]) {
        const draft = createInitialState();
        draft.workspaceName = "Original workspace";
        draft.pages[draft.currentPageId].title = "Original title";
        api.setState(draft);
        renderAll();
        const target = document.querySelector(selector);
        const original = target.textContent;
        target.focus();
        target.textContent = "Edited name";
        placeCaret(target, "end");
        target.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: "Edited name",
          }),
        );
        undo();
        const undone = {
          text: target.textContent,
          focused: document.activeElement === target,
          model:
            selector === "#page-title"
              ? getCurrentPage().title
              : getDocumentName(),
        };
        redo();
        const redone = {
          text: target.textContent,
          focused: document.activeElement === target,
          model:
            selector === "#page-title"
              ? getCurrentPage().title
              : getDocumentName(),
        };
        results.push({ selector, original, undone, redone });
        clearTimeout(_saveTimer);
        _saveTimer = null;
      }
      return results;
    });
    console.log("trial", trial, JSON.stringify(results));
    for (const result of results) {
      assert.deepEqual(result.undone, {
        text: result.original,
        focused: true,
        model: result.original,
      });
      assert.deepEqual(result.redone, {
        text: "Edited name",
        focused: true,
        model: "Edited name",
      });
    }
  }
  const display = await page.evaluate(() => {
    const draft = createInitialState();
    draft.uiLanguage = "en";
    draft.darkMode = false;
    draft.themeCustom = {};
    window.__LeafNoteTest.setState(draft);
    applyLanguage();
    applyThemeCustom();
    renderAll();
    const snapshot = () => ({
      language: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      search: document.querySelector("#search-label").textContent,
      width:
        document.documentElement.style.getPropertyValue("--page-max-width"),
    });
    const before = snapshot();
    state.uiLanguage = "ja";
    state.darkMode = true;
    state.themeCustom = { pageWidth: "wide" };
    applyLanguage();
    applyThemeCustom();
    saveState();
    const edited = snapshot();
    undo();
    const undone = snapshot();
    redo();
    const redone = snapshot();
    clearTimeout(_saveTimer);
    _saveTimer = null;
    return { before, edited, undone, redone };
  });
  assert.deepEqual(display.undone, display.before);
  assert.deepEqual(display.redone, display.edited);
  assert.notDeepEqual(display.before, display.edited);
  console.log("PASS: language, theme and width restore across history");
  console.log("PASS: focused title and document-name undo/redo, 5 trials each");
} finally {
  await page.close();
}
