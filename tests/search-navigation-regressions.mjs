import assert from "node:assert/strict";
import { APP_PATH } from "../scripts/app-path.mjs";
import { writeFile } from "node:fs/promises";
import { openTestPage } from "./test-page.mjs";
const [source = APP_PATH, engine = "chrome", output] = process.argv.slice(2);
const page = await openTestPage({
  source,
  engine,
  ready: "window.__LeafNoteTest?.isReady()",
});
try {
  const result = await page.evaluate(async () => {
    const api = window.__LeafNoteTest;
    const draft = createInitialState();
    const prototype = draft.pages[draft.currentPageId];
    for (let i = 0; i < 200; i++) {
      const id = "search-fixture-" + i;
      draft.pages[id] = {
        ...prototype,
        id,
        title: "Navigation fixture " + i,
        children: [],
        blocks: [blk("text", "Content " + i)],
      };
    }
    api.setState(draft);
    renderAll();
    openSearchModal();
    searchInput.value = "Navigation fixture";
    renderSearchResults(searchInput.value);
    const key = (value) =>
      searchInput.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      );
    const correct = () => {
      const selected = [
        ...searchResults.querySelectorAll(".search-item.selected"),
      ];
      if (
        selected.length !== 1 ||
        selected[0] !== searchItems[searchSelectedIdx]
      )
        throw Error("Selection index and DOM differ");
    };
    const samples = [];
    for (let trial = 0; trial < 5; trial++) {
      renderSearchResults(searchInput.value);
      const lists = new Set(searchItems.map((item) => item.classList));
      const original = DOMTokenList.prototype.remove;
      let removes = 0;
      DOMTokenList.prototype.remove = function (...tokens) {
        if (lists.has(this) && tokens.includes("selected")) removes++;
        return original.apply(this, tokens);
      };
      try {
        for (const operation of ["keyboard", "hover"]) {
          removes = 0;
          const start = performance.now();
          for (let i = 0; i < 600; i++) {
            if (operation === "keyboard") key("ArrowDown");
            else
              searchItems[(i + 1) % searchItems.length].dispatchEvent(
                new MouseEvent("mouseenter"),
              );
          }
          const handlerMs = performance.now() - start;
          correct();
          samples.push({
            trial,
            operation,
            inputs: 600,
            candidates: searchItems.length,
            removes,
            handlerMs,
          });
        }
      } finally {
        DOMTokenList.prototype.remove = original;
      }
    }
    renderSearchResults(searchInput.value);
    key("ArrowUp");
    const wrapUp = searchSelectedIdx === searchItems.length - 1;
    key("ArrowDown");
    const wrapDown = searchSelectedIdx === 0;
    const first = searchItems[0];
    first.dispatchEvent(new MouseEvent("mouseenter"));
    first.dispatchEvent(new MouseEvent("mouseenter"));
    correct();
    searchInput.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    key("ArrowDown");
    const imeUnchanged = searchSelectedIdx === 0;
    searchInput.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    renderSearchResults(searchInput.value);
    key("ArrowDown");
    const expectedTitle =
      searchItems[1].querySelector(".search-item-title").textContent;
    key("Enter");
    const opened =
      searchOverlay.hidden && getCurrentPage().title === expectedTitle;
    openSearchModal();
    searchInput.value = "Navigation created note";
    renderSearchResults(searchInput.value);
    const onlyCreate = searchItems.length === 1;
    key("ArrowUp");
    key("ArrowDown");
    correct();
    key("Enter");
    const created =
      searchOverlay.hidden &&
      getCurrentPage().title === "Navigation created note";
    openSearchModal();
    key("Escape");
    const closed = searchOverlay.hidden;
    return {
      samples,
      checks: {
        wrapUp,
        wrapDown,
        imeUnchanged,
        opened,
        onlyCreate,
        created,
        closed,
      },
    };
  });
  for (const [name, passed] of Object.entries(result.checks))
    assert.equal(passed, true, name);
  if (output)
    await writeFile(
      output,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          source,
          engine,
          version: page.version,
          conditions:
            "Synthetic keyboard/mouse events, warm page, 5 trials, handler CPU only; instrumented class removal counts. Not native input latency, presentation or INP.",
          ...result,
        },
        null,
        2,
      ),
    );
  console.log("PASS search navigation", engine, JSON.stringify(result));
} finally {
  await page.close();
}
