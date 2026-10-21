import assert from "node:assert/strict";

export function createInteractionTests({ evaluate, js }) {
  return [
    {
      name: "interaction: long code selections retain exact offsets even when escaped markup exceeds the rich HTML limit",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              originalPrism = window.Prism;
            try {
              window.Prism = {
                highlightElement(el) {
                  el.innerHTML =
                    "<span>" + escapeHTML(el.textContent) + "</span>";
                },
              };
              const draft = api.createInitialState(),
                raw = "<&".repeat(180000);
              draft.pages[draft.currentPageId].blocks = [blk("code", raw)];
              api.setState(draft);
              api.renderAll();
              const code = document.querySelector("code[data-block-id]");
              code.focus();
              getSelection().setBaseAndExtent(
                code.firstChild,
                350000,
                code.firstChild,
                349980,
              );
              await new Promise((r) => setTimeout(r, 80));
              const offset = (node, position) => {
                const range = document.createRange();
                range.selectNodeContents(code);
                range.setEnd(node, position);
                return range.toString().length;
              };
              const selection = getSelection();
              return {
                anchor: offset(selection.anchorNode, selection.anchorOffset),
                focus: offset(selection.focusNode, selection.focusOffset),
                text: code.textContent === raw,
              };
            } finally {
              window.Prism = originalPrism;
            }
          }),
        );
        assert.deepEqual(result, { anchor: 350000, focus: 349980, text: true });
      },
    },
    {
      name: "interaction: governance text fields preserve spaces between typed words",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              rows = [];
            for (const type of ["decision", "requirement", "open_question"]) {
              const draft = api.createInitialState(),
                block = blk(type, "body");
              draft.pages[draft.currentPageId].blocks = [block];
              api.setState(draft);
              api.renderAll();
              const input = document.querySelector(
                '.governance-control[type="text"]',
              );
              input.value = "";
              input.focus();
              for (const char of "First Last 日本語") {
                input.value += char;
                input.dispatchEvent(
                  new InputEvent("input", {
                    bubbles: true,
                    data: char,
                    inputType: "insertText",
                  }),
                );
              }
              const value = input.value;
              api.renderAll();
              rows.push({
                value,
                rerendered: document.querySelector(
                  '.governance-control[type="text"]',
                ).value,
              });
            }
            return rows;
          }),
        );
        assert.deepEqual(
          result,
          Array(3).fill({
            value: "First Last 日本語",
            rerendered: "First Last 日本語",
          }),
        );
      },
    },
    {
      name: "interaction: table boundary keys allow leaving without exceeding the row limit",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            const table = blk("table", "", {
              rows: TABLE_MAX_ROWS,
              cols: 1,
              cells: Array.from({ length: TABLE_MAX_ROWS }, () => ["text"]),
            });
            draft.pages[draft.currentPageId].blocks = [table];
            api.setState(draft);
            api.renderAll();
            const cells = document.querySelectorAll(
              ".simple-table th, .simple-table td",
            );
            const backwards = new KeyboardEvent("keydown", {
              key: "Tab",
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            });
            const forwards = new KeyboardEvent("keydown", {
              key: "Tab",
              bubbles: true,
              cancelable: true,
            });
            cells[0].dispatchEvent(backwards);
            cells[cells.length - 1].dispatchEvent(forwards);
            return {
              backwards: backwards.defaultPrevented,
              forwards: forwards.defaultPrevented,
              rows: table.rows,
              expected: TABLE_MAX_ROWS,
            };
          }),
        );
        assert.equal(result.backwards, false);
        assert.equal(result.forwards, false);
        assert.equal(result.rows, result.expected);
      },
    },
    {
      name: "interaction: code highlighting preserves backward selections and skips unchanged or detached content",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              originalPrism = window.Prism;
            let calls = 0;
            try {
              window.Prism = {
                highlightElement(el) {
                  calls++;
                  el.innerHTML =
                    "<span>" + escapeHTML(el.textContent) + "</span>";
                },
              };
              const draft = api.createInitialState();
              draft.pages[draft.currentPageId].blocks = [blk("code", "abcdef")];
              api.setState(draft);
              api.renderAll();
              await new Promise((r) => setTimeout(r, 20));
              const code = document.querySelector("code[data-block-id]");
              code.focus();
              code.textContent = "abcdef!";
              getSelection().setBaseAndExtent(
                code.firstChild,
                5,
                code.firstChild,
                2,
              );
              code.dispatchEvent(new Event("input", { bubbles: true }));
              await new Promise((r) => setTimeout(r, 450));
              const selected = getSelection().toString(),
                offsets = _captureRichSelectionOffsets(code);
              const afterEdit = calls;
              code.dispatchEvent(new FocusEvent("blur"));
              code.dispatchEvent(new FocusEvent("blur"));
              const unchanged = calls === afterEdit;
              code.dispatchEvent(new Event("input", { bubbles: true }));
              code.closest(".block").remove();
              await new Promise((r) => setTimeout(r, 450));
              return {
                selected,
                offsets,
                unchanged,
                detached: calls === afterEdit,
              };
            } finally {
              window.Prism = originalPrism;
            }
          }),
        );
        assert.deepEqual(result, {
          selected: "cde",
          offsets: { anchor: 5, focus: 2 },
          unchanged: true,
          detached: true,
        });
      },
    },
    {
      name: "interaction: code highlighting waits for IME confirmation",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              originalPrism = window.Prism;
            let calls = 0;
            try {
              window.Prism = {
                highlightElement(el) {
                  calls++;
                  el.innerHTML =
                    "<span>" + escapeHTML(el.textContent) + "</span>";
                },
              };
              const draft = api.createInitialState();
              draft.pages[draft.currentPageId].blocks = [blk("code", "before")];
              api.setState(draft);
              api.renderAll();
              await new Promise((r) => setTimeout(r, 20));
              const code = document.querySelector("code[data-block-id]");
              code.focus();
              code.dispatchEvent(
                new CompositionEvent("compositionstart", { bubbles: true }),
              );
              code.textContent = "変換中";
              code.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  isComposing: true,
                  inputType: "insertCompositionText",
                }),
              );
              const before = calls;
              await new Promise((r) => setTimeout(r, 450));
              const waited = calls === before;
              code.textContent = "変換確定";
              code.dispatchEvent(
                new CompositionEvent("compositionend", { bubbles: true }),
              );
              await new Promise((r) => setTimeout(r, 450));
              return {
                waited,
                highlighted: calls > before,
                saved: getCurrentPage().blocks[0].content,
              };
            } finally {
              window.Prism = originalPrism;
            }
          }),
        );
        assert.deepEqual(result, {
          waited: true,
          highlighted: true,
          saved: "変換確定",
        });
      },
    },
    {
      name: "interaction: file drops inside nested blocks insert exactly once at the chosen child",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              results = [];
            for (const type of ["text/plain", "image/png"]) {
              const draft = api.createInitialState(),
                child = blk("text", "child");
              const parent = blk("toggle", "parent", {
                expanded: true,
                children: [child],
              });
              draft.pages[draft.currentPageId].blocks = [parent];
              api.setState(draft);
              api.renderAll();
              const target = document.querySelector(
                blockEditableSelectorById(child.id),
              );
              const data = new DataTransfer();
              data.items.add(
                new File(
                  ["content"],
                  type === "image/png" ? "test.png" : "test.txt",
                  { type },
                ),
              );
              target.dispatchEvent(
                new DragEvent("drop", {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer: data,
                  clientY: target.getBoundingClientRect().bottom,
                }),
              );
              await new Promise((r) => setTimeout(r, 100));
              results.push({
                roots: getCurrentPage().blocks.length,
                children: parent.children.map((b) => b.type),
              });
            }
            return results;
          }),
        );
        assert.deepEqual(result, [
          { roots: 1, children: ["text", "file"] },
          { roots: 1, children: ["text", "image"] },
        ]);
      },
    },
    {
      name: "interaction: Escape closes only the front dialog and modal shortcuts leave the document untouched",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            api.renderAll();
            openThemeCustomizer();
            const pending = showConfirm("test");
            await new Promise((r) => setTimeout(r, 70));
            document.activeElement.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
                cancelable: true,
              }),
            );
            const nested = {
              result: await pending,
              dialogClosed: dialogOverlay.hidden,
              settingsOpen: !document.querySelector("#theme-customizer-overlay")
                .hidden,
            };
            const before = JSON.stringify(state);
            for (const key of ["z", "k", "/"])
              document.activeElement.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key,
                  ctrlKey: true,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            const protectedState = before === JSON.stringify(state),
              searchClosed = searchOverlay.hidden;
            const shortcutsClosed =
              document.querySelector("#shortcuts-overlay").hidden;
            closeThemeCustomizer();
            closeSearchModal();
            closeShortcutsModal();
            return { nested, protectedState, searchClosed, shortcutsClosed };
          }),
        );
        assert.deepEqual(result, {
          nested: { result: null, dialogClosed: true, settingsOpen: true },
          protectedState: true,
          searchClosed: true,
          shortcutsClosed: true,
        });
      },
    },
  ];
}
