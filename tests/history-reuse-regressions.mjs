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
  const result = await page.evaluate(async () => {
    const api = window.__LeafNoteTest;
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(resolve));
    const draft = createInitialState();
    draft.pages[draft.currentPageId].blocks = Array.from(
      { length: 1000 },
      (_, i) => blk("text", "Block " + i),
    );
    api.setState(draft);
    renderAll();
    await frame();
    await frame();
    const original = JSON.stringify(getCurrentPage().blocks);
    const untouched = document.querySelectorAll("#blocks > .block")[10];
    const beforeList = getCurrentPage().blocks;
    const text = document.querySelector("#blocks .block-content");
    text.focus();
    text.innerHTML = "Edited first";
    text.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Edited first",
      }),
    );
    undo();
    const restored = JSON.stringify(getCurrentPage().blocks) === original;
    const reused =
      document.querySelectorAll("#blocks > .block")[10] === untouched;
    const listStable = getCurrentPage().blocks === beforeList;
    redo();
    const redoCorrect = getCurrentPage().blocks[0].content === "Edited first";
    const retainedContent = untouched.querySelector(".block-content");
    retainedContent.innerHTML = "Edit through reused handler";
    retainedContent.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Edit through reused handler",
      }),
    );
    const handlerCurrent =
      getCurrentPage().blocks[10].content === "Edit through reused handler";
    deleteBlock(getCurrentPage().blocks.at(-1).id);
    const addButton = untouched.querySelector(".block-gutter-btn");
    addButton.click();
    const label = getBlockTypeName(
      getBlockPickerTypes().find((item) => item.type === "text"),
    );
    const menuItem = Array.from(
      document.querySelectorAll("#context-menu .ctx-item"),
    ).find((item) => item.getAttribute("aria-label") === label);
    menuItem.click();
    const parentHandlerCurrent =
      getCurrentPage().blocks.length === 1000 &&
      getCurrentPage().blocks[10].content === "Edit through reused handler" &&
      getCurrentPage().blocks[11].type === "text" &&
      getCurrentPage().blocks[12].content === "Block 11";
    clearTimeout(_saveTimer);
    _saveTimer = null;
    const saved = await _doSave({ force: true });
    const loaded = await loadStateAsync();
    const persisted =
      JSON.stringify(loaded.pages[state.currentPageId].blocks) ===
      JSON.stringify(getCurrentPage().blocks);
    const order = createInitialState();
    order.pages[order.currentPageId].blocks = [
      blk("text", "A"),
      blk("text", "B"),
      blk("text", "C"),
    ];
    api.setState(order);
    renderAll();
    await frame();
    await frame();
    const beforeOrder = getCurrentPage().blocks.map((block) => block.id);
    getCurrentPage().blocks.reverse();
    saveState();
    undo();
    const undoOrder =
      Array.from(
        document.querySelectorAll("#blocks > .block"),
        (el) => el.dataset.id,
      ).join(",") === beforeOrder.join(",");
    redo();
    const redoOrder =
      Array.from(
        document.querySelectorAll("#blocks > .block"),
        (el) => el.dataset.id,
      ).join(",") === [...beforeOrder].reverse().join(",");
    const big = createInitialState();
    big.pages[big.currentPageId].blocks = [
      blk("text", "x".repeat(40000)),
      blk("text", "Small"),
    ];
    api.setState(big);
    renderAll();
    await frame();
    await frame();
    const bigElement = document.querySelector("#blocks > .block");
    getCurrentPage().blocks[1].content = "Changed small";
    saveState();
    undo();
    const largeFresh =
      document.querySelector("#blocks > .block") !== bigElement &&
      getCurrentPage().blocks[0].content.length === 40000;
    const todoDraft = createInitialState();
    todoDraft.pages[todoDraft.currentPageId].blocks = [
      blk("todo", "Accessible task"),
    ];
    api.setState(todoDraft);
    renderAll();
    const checkbox = document.querySelector(".todo-checkbox");
    const todoNamed = checkbox.getAttribute("aria-label") === t("common.done");
    checkbox.click();
    const todoChecked = getCurrentPage().blocks[0].checked === true;
    undo();
    const todoRestored =
      !document.querySelector(".todo-checkbox").checked &&
      !getCurrentPage().blocks[0].checked;
    // A derived block must be rendered against the restored headings.
    const mixed = createInitialState();
    mixed.pages[mixed.currentPageId].blocks = [
      blk("h1", "First heading"),
      blk("toc", ""),
      blk("toggle", "Parent", { children: [blk("text", "Child")] }),
      blk("table", ""),
    ];
    api.setState(mixed);
    renderAll();
    await frame();
    await frame();
    const toc = document.querySelectorAll("#blocks > .block")[1];
    getCurrentPage().blocks[0].content = "New heading";
    saveState();
    undo();
    const tocFresh = document.querySelectorAll("#blocks > .block")[1] !== toc;
    const nestedCorrect =
      getCurrentPage().blocks[2].children[0].content === "Child";
    // Markup changed outside model notifications cannot be reused as correct UI.
    const dirty = document.querySelector("#blocks > .block");
    dirty.querySelector(".block-content").textContent = "Untracked DOM";
    getCurrentPage().blocks[3].content = "Changed other block";
    saveState();
    undo();
    const dirtyRebuilt = document.querySelector("#blocks > .block") !== dirty;
    const dirtyCorrect =
      document.querySelector("#blocks > .block .block-content").textContent ===
      getCurrentPage().blocks[0].content;
    clearTimeout(_saveTimer);
    _saveTimer = null;
    return {
      restored,
      reused,
      listStable,
      redoCorrect,
      handlerCurrent,
      parentHandlerCurrent,
      saved,
      persisted,
      tocFresh,
      nestedCorrect,
      dirtyRebuilt,
      dirtyCorrect,
      undoOrder,
      redoOrder,
      largeFresh,
      todoNamed,
      todoChecked,
      todoRestored,
    };
  });
  console.log(JSON.stringify(result));
  for (const [name, value] of Object.entries(result))
    assert.equal(value, true, name);
  console.log(
    "PASS: large history, live handlers/list, persistence, derived/nested blocks and dirty DOM",
  );
} finally {
  await page.close();
}
