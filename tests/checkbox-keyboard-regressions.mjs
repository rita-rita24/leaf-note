import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { launchBrowser, stopBrowser } from "./loading-cdp.mjs";
const [source = "leaf-note.html", engine = "chrome", output] =
  process.argv.slice(2);
let ownedChrome, browser;
const rows = [];
try {
  if (engine === "chrome") {
    ownedChrome = await launchBrowser();
    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${ownedChrome.port}`,
    );
  } else {
    const type = { firefox, webkit }[engine];
    if (!type) throw new Error("Unknown engine: " + engine);
    browser = await type.launch({ headless: true });
  }
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const url =
    (source.startsWith("http") ? source : pathToFileURL(resolve(source)).href) +
    "?test=1";
  await page.goto(url);
  await page.waitForFunction("window.__LeafNoteTest?.isReady()");
  for (let trial = 0; trial < 5; trial++) {
    const label = await page.evaluate(() => {
      document.activeElement?.blur();
      const draft = createInitialState();
      draft.pages[draft.currentPageId].blocks = [blk("todo", "Keyboard task")];
      window.__LeafNoteTest.setState(draft);
      renderAll({ forceEditableSync: true });
      window.__checkboxEvents = [];
      document
        .querySelector(".todo-checkbox")
        .addEventListener("input", (event) =>
          window.__checkboxEvents.push({
            type: event.type,
            isTrusted: event.isTrusted,
          }),
        );
      return t("common.done");
    });
    assert.ok(label);
    const checkbox = page.getByRole("checkbox", { name: label, exact: true });
    assert.equal(await checkbox.count(), 1);
    await checkbox.press("Space");
    assert.equal(await checkbox.isChecked(), true);
    const checked = await page.evaluate(
      () =>
        getCurrentPage().blocks[0].checked === true &&
        document.activeElement.classList.contains("todo-checkbox"),
    );
    assert.equal(checked, true);
    await checkbox.press("Space");
    assert.equal(await checkbox.isChecked(), false);
    const unchecked = await page.evaluate(
      () =>
        getCurrentPage().blocks[0].checked === false &&
        document.activeElement.classList.contains("todo-checkbox"),
    );
    assert.equal(unchecked, true);
    const events = await page.evaluate(() => window.__checkboxEvents);
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.isTrusted));
    const persisted = await page.evaluate(async () => {
      clearTimeout(_saveTimer);
      _saveTimer = null;
      let saved = false;
      for (let i = 0; i < 100 && !saved; i++) {
        saved = await _doSave({ force: true });
        if (!saved) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const stored = await loadStateAsync();
      return (
        saved && stored.pages[stored.currentPageId].blocks[0].checked === false
      );
    });
    assert.equal(persisted, true);
    rows.push({ trial, label, checked, unchecked, events, persisted });
  }
  const result = {
    source,
    engine,
    browser: browser.version(),
    dateUTC: new Date().toISOString(),
    rows,
    limits:
      "Browser native keyboard dispatch and accessible-name locator, not physical keyboard or screen-reader validation",
  };
  if (output) await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  console.log(
    "PASS: 5 named-checkbox trials; trusted Space toggles, focus and persistence",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    if (ownedChrome) await stopBrowser(ownedChrome);
  }
}
