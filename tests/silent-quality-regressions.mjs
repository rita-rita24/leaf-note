import assert from "node:assert/strict";

export function createSilentQualityTests({ evaluate, js }) {
  return [
    {
      name: "silent: Markdown paste accounts for the existing target nesting depth",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            const leaf = blk("text", ""),
              originalAlert = showAlert;
            let root = leaf,
              alerts = 0;
            for (let i = 0; i < BLOCK_MAX_DEPTH; i++)
              root = blk("toggle", "parent", {
                expanded: true,
                children: [root],
              });
            draft.pages[draft.currentPageId].blocks = [root];
            api.setState(draft);
            api.renderAll();
            const before = JSON.stringify(getCurrentPage().blocks),
              target = document.querySelector(
                blockEditableSelectorById(leaf.id),
              );
            target.focus();
            placeCaret(target, "end");
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/markdown", "- outer\n  - too deep");
            try {
              showAlert = async () => {
                alerts++;
              };
              await handleBlockPaste(
                { clipboardData, currentTarget: target, preventDefault() {} },
                leaf,
                target,
              );
            } finally {
              showAlert = originalAlert;
            }
            return {
              unchanged: JSON.stringify(getCurrentPage().blocks) === before,
              alerts,
            };
          }),
        );
        assert.deepEqual(result, { unchanged: true, alerts: 1 });
      },
    },
    {
      name: "silent: oversized Markdown table dimensions cannot silently discard pasted rows or columns",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              results = [],
              originalAlert = showAlert;
            try {
              for (const [rows, cols] of [
                [101, 2],
                [2, 101],
              ]) {
                const draft = api.createInitialState();
                draft.pages[draft.currentPageId].blocks = [
                  blk("text", "Original"),
                ];
                api.setState(draft);
                api.renderAll();
                let alerts = 0;
                showAlert = async () => {
                  alerts++;
                };
                const row = "| " + Array(cols).fill("cell").join(" | ") + " |";
                const divider =
                  "| " + Array(cols).fill("---").join(" | ") + " |";
                const markdown = [
                  row,
                  divider,
                  ...Array(rows - 1).fill(row),
                ].join("\n");
                const before = JSON.stringify(getCurrentPage().blocks),
                  target = document.querySelector("[data-block-id]");
                target.focus();
                placeCaret(target, "end");
                const clipboardData = new DataTransfer();
                clipboardData.setData("text/markdown", markdown);
                await handleBlockPaste(
                  { clipboardData, currentTarget: target, preventDefault() {} },
                  getCurrentPage().blocks[0],
                  target,
                );
                results.push({
                  unchanged: JSON.stringify(getCurrentPage().blocks) === before,
                  alerts,
                });
              }
            } finally {
              showAlert = originalAlert;
            }
            return results;
          }),
        );
        assert.deepEqual(result, Array(2).fill({ unchanged: true, alerts: 1 }));
      },
    },
    {
      name: "silent: Markdown import rejects lossy field or nesting limits before creating a page",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              results = [],
              originalClick = HTMLInputElement.prototype.click,
              originalAlert = showAlert;
            let input,
              alerts = 0;
            try {
              HTMLInputElement.prototype.click = function () {
                input = this;
              };
              showAlert = async () => {
                alerts++;
              };
              const inputs = [
                "```text\n" +
                  "x".repeat(RAW_TEXT_BLOCK_MAX_BYTES + 1) +
                  "\n```",
                "&".repeat(Math.floor(RICH_HTML_FIELD_MAX_BYTES / 5) + 1),
                Array.from(
                  { length: BLOCK_MAX_DEPTH + 2 },
                  (_, depth) => "  ".repeat(depth) + "- nested",
                ).join("\n"),
                "# " + "x".repeat(TEXT_FIELD_MAX_CHARS + 1) + "\n\nBody",
              ];
              for (const text of inputs) {
                api.setState(api.createInitialState());
                api.renderAll();
                alerts = 0;
                const before = JSON.stringify(state.pages);
                importMarkdownAsNewPage();
                Object.defineProperty(input, "files", {
                  value: [
                    new File([text], "limits.md", { type: "text/markdown" }),
                  ],
                });
                await input.onchange();
                results.push({
                  unchanged: JSON.stringify(state.pages) === before,
                  alerts,
                });
              }
            } finally {
              HTMLInputElement.prototype.click = originalClick;
              showAlert = originalAlert;
            }
            return results;
          }),
        );
        assert.deepEqual(result, Array(4).fill({ unchanged: true, alerts: 1 }));
      },
    },
    {
      name: "silent: modal copy and cut leave background block selections untouched",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("text", "Keep this note"),
            ];
            api.setState(draft);
            api.renderAll();
            BlockSelection.selectOne(getCurrentPage().blocks[0].id);
            const before = JSON.stringify(getCurrentPage().blocks);
            showAlert("Modal text");
            const button =
              document.querySelector("#dialog-box [data-ok]") ||
              dialogBox.querySelector("[data-ok]");
            button.focus();
            const events = ["copy", "cut"].map((type) => {
              const clipboardData = new DataTransfer();
              const event = new ClipboardEvent(type, {
                clipboardData,
                bubbles: true,
                cancelable: true,
              });
              button.dispatchEvent(event);
              return {
                prevented: event.defaultPrevented,
                text: clipboardData.getData("text/plain"),
              };
            });
            const unchanged =
              JSON.stringify(getCurrentPage().blocks) === before;
            hideDialog(true);
            BlockSelection.clear();
            return { unchanged, events };
          }),
        );
        assert.deepEqual(result, {
          unchanged: true,
          events: Array(2).fill({ prevented: false, text: "" }),
        });
      },
    },
    {
      name: "silent: modal focus trapping leaves browser Tab shortcuts available",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            showAlert("Modal text");
            const button = dialogBox.querySelector("[data-ok]");
            button.focus();
            const results = ["ctrlKey", "metaKey", "altKey"].map((modifier) => {
              const event = new KeyboardEvent("keydown", {
                key: "Tab",
                [modifier]: true,
                bubbles: true,
                cancelable: true,
              });
              button.dispatchEvent(event);
              return event.defaultPrevented;
            });
            hideDialog(true);
            return results;
          }),
        );
        assert.deepEqual(result, [false, false, false]);
      },
    },
    {
      name: "silent: switching pages synchronizes an actively focused title",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            const other = api.createPage(null, { title: "Destination title" });
            draft.pages[draft.currentPageId].title = "Previous title";
            api.setState(draft);
            api.renderAll();
            document.querySelector("#page-title").focus();
            switchPage(other.id);
            return {
              dom: document.querySelector("#page-title").textContent,
              state: getCurrentPage().title,
            };
          }),
        );
        assert.deepEqual(result, {
          dom: "Destination title",
          state: "Destination title",
        });
      },
    },
    {
      name: "silent: composing titles keep their DOM until IME commits",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            api.renderAll();
            const target = document.querySelector("#page-title");
            target.focus();
            target.textContent = "日本語  変換";
            const text = target.firstChild;
            target.dispatchEvent(
              new CompositionEvent("compositionstart", { bubbles: true }),
            );
            target.dispatchEvent(
              new InputEvent("input", { bubbles: true, isComposing: true }),
            );
            const during = {
              sameNode: target.firstChild === text,
              text: target.textContent,
            };
            target.dispatchEvent(
              new CompositionEvent("compositionend", { bubbles: true }),
            );
            return {
              during,
              dom: target.textContent,
              state: getCurrentPage().title,
            };
          }),
        );
        assert.deepEqual(result, {
          during: { sameNode: true, text: "日本語  変換" },
          dom: "日本語 変換",
          state: "日本語 変換",
        });
      },
    },
    {
      name: "silent: typing a title updates its label without rebuilding the page tree",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            for (let i = 0; i < 50; i++)
              api.createPage(null, { title: `Other ${i}` });
            api.setState(draft);
            api.renderAll();
            const items = Array.from(
              document.querySelectorAll("#page-tree .page-item"),
            );
            const target = document.querySelector("#page-title");
            target.focus();
            for (let i = 0; i < 20; i++) {
              target.textContent = `Renamed ${i}`;
              target.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  inputType: "insertText",
                }),
              );
            }
            const active = document.querySelector(
              "#page-tree .page-item.active",
            );
            return {
              retained: items.filter((item) => item.isConnected).length,
              total: items.length,
              label: active.querySelector(".page-item-title").textContent,
              aria: active.getAttribute("aria-label"),
            };
          }),
        );
        assert.equal(result.retained, result.total);
        assert.equal(result.label, "Renamed 19");
        assert.ok(result.aria.includes("Renamed 19"));
      },
    },
    {
      name: "silent: expanding sidebar children retains keyboard focus on the same control",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            api.createPage(draft.currentPageId, { title: "Child" });
            api.setState(draft);
            api.renderAll();
            const id = draft.currentPageId;
            const button = document.querySelector(
              `[data-page-id="${id}"] .page-item-chevron`,
            );
            button.focus();
            button.click();
            const focused = document.activeElement;
            return {
              isChevron: focused.classList.contains("page-item-chevron"),
              pageId: focused.closest("[data-page-id]")?.dataset.pageId,
              id,
              expanded: focused.getAttribute("aria-expanded"),
            };
          }),
        );
        assert.equal(result.isChevron, true);
        assert.equal(result.pageId, result.id);
        assert.equal(result.expanded, "true");
      },
    },
    ...["page-title", "document-name"].map((id) => ({
      name: `silent: undo and redo synchronize the focused ${id} with saved state`,
      run: async (page) => {
        const result = await evaluate(
          page,
          `(${async (id) => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            draft.pages[draft.currentPageId].title = "Original title";
            draft.workspaceName = "Original name";
            api.setState(draft);
            api.renderAll();
            const target = document.getElementById(id),
              original = target.textContent;
            target.focus();
            target.textContent = "Edited value";
            placeCaret(target, "end");
            target.dispatchEvent(new Event("input", { bubbles: true }));
            undo();
            const undone = {
              dom: target.textContent,
              state:
                id === "page-title"
                  ? getCurrentPage().title
                  : state.workspaceName,
              focused: document.activeElement === target,
            };
            redo();
            return {
              original,
              undone,
              redone: {
                dom: target.textContent,
                state:
                  id === "page-title"
                    ? getCurrentPage().title
                    : state.workspaceName,
              },
            };
          }})(${JSON.stringify(id)})`,
        );
        assert.deepEqual(result.undone, {
          dom: result.original,
          state: result.original,
          focused: true,
        });
        assert.deepEqual(result.redone, {
          dom: "Edited value",
          state: "Edited value",
        });
      },
    })),
    {
      name: "silent: history preserves reverse selections and soft line break positions",
      run: async (page) => {
        const results = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              results = [];
            for (const offsets of [
              { anchor: 3, focus: 3 },
              { anchor: 5, focus: 3 },
            ]) {
              const draft = api.createInitialState();
              draft.pages[draft.currentPageId].blocks = [
                blk("text", "AB<br>CDE"),
              ];
              api.setState(draft);
              api.renderAll();
              let target = document.querySelector("[data-block-id]");
              target.focus();
              target.innerHTML = "AB<br>CDEF";
              target.dispatchEvent(new Event("input", { bubbles: true }));
              _restoreRichSelectionOffsets(target, offsets);
              undo();
              target = document.querySelector("[data-block-id]");
              results.push({
                content: target.innerHTML,
                selection: _captureRichSelectionOffsets(target),
              });
            }
            return results;
          }),
        );
        assert.deepEqual(results, [
          { content: "AB<br>CDE", selection: { anchor: 3, focus: 3 } },
          { content: "AB<br>CDE", selection: { anchor: 5, focus: 3 } },
        ]);
      },
    },
    {
      name: "silent: Backspace joins after all preceding soft line breaks",
      run: async (page) => {
        const results = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              results = [];
            for (const prefix of ["A<br>", "<br><br>", "<b>A</b><br><br>"]) {
              const draft = api.createInitialState();
              draft.pages[draft.currentPageId].blocks = [
                blk("text", prefix),
                blk("text", "B"),
              ];
              api.setState(draft);
              api.renderAll();
              const target = document.querySelectorAll("[data-block-id]")[1];
              target.focus();
              placeCaret(target, "start");
              target.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "Backspace",
                  bubbles: true,
                  cancelable: true,
                }),
              );
              await new Promise((resolve) => setTimeout(resolve, 20));
              const joined = document.querySelector("[data-block-id]");
              const range = getSelection().getRangeAt(0).cloneRange();
              range.selectNodeContents(joined);
              range.setEnd(
                getSelection().focusNode,
                getSelection().focusOffset,
              );
              const fragment = range.cloneContents();
              results.push({
                count: getCurrentPage().blocks.length,
                content: joined.innerHTML,
                prefixText: fragment.textContent,
                breaks: fragment.querySelectorAll("br").length,
              });
            }
            return results;
          }),
        );
        assert.deepEqual(results, [
          { count: 1, content: "A<br>B", prefixText: "A", breaks: 1 },
          { count: 1, content: "<br><br>B", prefixText: "", breaks: 2 },
          {
            count: 1,
            content: "<b>A</b><br><br>B",
            prefixText: "A",
            breaks: 2,
          },
        ]);
      },
    },
    {
      name: "silent: table browser shortcuts never add rows or move focus",
      run: async (page) => {
        const results = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              results = [];
            for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
              const draft = api.createInitialState();
              draft.pages[draft.currentPageId].blocks = [
                blk("table", "", { rows: 1, cols: 1, cells: [["value"]] }),
              ];
              api.setState(draft);
              api.renderAll();
              const target = document.querySelector(
                ".simple-table th, .simple-table td",
              );
              target.focus();
              const event = new KeyboardEvent("keydown", {
                key: "Tab",
                [modifier]: true,
                bubbles: true,
                cancelable: true,
              });
              target.dispatchEvent(event);
              results.push({
                prevented: event.defaultPrevented,
                rows: getCurrentPage().blocks[0].rows,
                focused: document.activeElement === target,
              });
            }
            return results;
          }),
        );
        assert.deepEqual(
          results,
          Array(3).fill({ prevented: false, rows: 1, focused: true }),
        );
      },
    },
    {
      name: "silent: title selection shortcuts keep their native behavior",
      run: async (page) => {
        const results = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            api.renderAll();
            const target = document.querySelector("#page-title");
            return ["shiftKey", "ctrlKey", "metaKey", "altKey"].map(
              (modifier) => {
                target.focus();
                placeCaret(target, "start");
                const event = new KeyboardEvent("keydown", {
                  key: "ArrowDown",
                  [modifier]: true,
                  bubbles: true,
                  cancelable: true,
                });
                target.dispatchEvent(event);
                return {
                  prevented: event.defaultPrevented,
                  focused: document.activeElement === target,
                };
              },
            );
          }),
        );
        assert.deepEqual(
          results,
          Array(4).fill({ prevented: false, focused: true }),
        );
      },
    },
    {
      name: "silent: task shortcuts keep checked status and rich content",
      run: async (page) => {
        const results = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              results = [];
            for (const marker of [
              "- [x] ",
              "* [X] ",
              "+ [ ] ",
              "[] ",
              "[ ] ",
            ]) {
              const draft = api.createInitialState();
              draft.pages[draft.currentPageId].blocks = [blk("text", "")];
              api.setState(draft);
              api.renderAll();
              const target = document.querySelector("[data-block-id]");
              target.focus();
              target.innerHTML = marker + "<b>task</b>";
              placeCaret(target, "end");
              target.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  inputType: "insertText",
                }),
              );
              const block = getCurrentPage().blocks[0];
              results.push({
                type: block.type,
                checked: block.checked,
                content: block.content,
              });
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return results;
          }),
        );
        assert.deepEqual(
          results,
          [true, true, false, false, false].map((checked) => ({
            type: "todo",
            checked,
            content: "<b>task</b>",
          })),
        );
      },
    },
  ];
}
