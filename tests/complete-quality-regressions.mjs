import assert from "node:assert/strict";

export function createCompleteQualityTests({ evaluate, js }) {
  return [
    {
      name: "complete: math editing replaces its preview instead of accumulating old values",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const draft = window.__LeafNoteTest.createInitialState();
            draft.pages[draft.currentPageId].blocks = [blk("math", "initial")];
            window.__LeafNoteTest.setState(draft);
            renderAll();
            const input = document.querySelector(".raw-block-textarea");
            for (let i = 0; i < 40; i++) {
              input.value = `x_${i}`;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
            return {
              previews: Array.from(
                document.querySelectorAll(".raw-block > pre"),
              ).map((el) => el.textContent),
              content: getCurrentPage().blocks[0].content,
            };
          }),
        );
        assert.deepEqual(result, { previews: ["x_39"], content: "x_39" });
      },
    },
    {
      name: "complete: unchanged raw previews retain their DOM and composition waits for commit",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const rows = [];
            for (const [type, content] of [
              ["html", "<b>before</b>"],
              ["math", "x"],
              ["mermaid", "graph TD\nA-->B"],
            ]) {
              const draft = window.__LeafNoteTest.createInitialState();
              draft.pages[draft.currentPageId].blocks = [blk(type, content)];
              window.__LeafNoteTest.setState(draft);
              renderAll();
              const wrap = document.querySelector(".raw-block"),
                input = wrap.querySelector("textarea");
              const preview = wrap.lastElementChild;
              for (let i = 0; i < 20; i++)
                input.dispatchEvent(new Event("input", { bubbles: true }));
              const unchanged = wrap.lastElementChild === preview;
              input.dispatchEvent(
                new CompositionEvent("compositionstart", { bubbles: true }),
              );
              input.value = "日本語";
              input.dispatchEvent(
                new InputEvent("input", { bubbles: true, isComposing: true }),
              );
              const deferred = wrap.lastElementChild === preview;
              input.dispatchEvent(
                new CompositionEvent("compositionend", { bubbles: true }),
              );
              rows.push({
                type,
                unchanged,
                deferred,
                committed: wrap.lastElementChild !== preview,
                content: getCurrentPage().blocks[0].content,
              });
            }
            return rows;
          }),
        );
        for (const row of rows)
          assert.deepEqual(row, {
            type: row.type,
            unchanged: true,
            deferred: true,
            committed: true,
            content: "日本語",
          });
      },
    },
    {
      name: "complete: table, caption and definition formatting survives rerender and Undo",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(async () => {
            const rows = [],
              originalExec = document.execCommand,
              originalPrompt = showPrompt;
            try {
              document.execCommand = () => false;
              showPrompt = async () => "https://example.com/";
              for (const selector of [
                ".simple-table th",
                ".image-caption",
                ".definition-list dt",
                ".definition-list dd",
              ]) {
                for (const command of ["color", "code", "bold", "link"]) {
                  const draft = window.__LeafNoteTest.createInitialState();
                  window.__LeafNoteTest.setState(draft);
                  getCurrentPage().blocks = [
                    blk("table", "", { rows: 1, cols: 1, cells: [["sample"]] }),
                    blk("image", "", {
                      url: "data:image/png;base64,iVBORw0KGgo=",
                      caption: "sample",
                    }),
                    blk("definition_list", "", {
                      definitions: [{ term: "sample", definition: "sample" }],
                    }),
                  ];
                  _captureUndoBaseline();
                  renderAll();
                  const target = document.querySelector(selector);
                  target.focus();
                  const range = document.createRange();
                  range.selectNodeContents(target);
                  getSelection().removeAllRanges();
                  getSelection().addRange(range);
                  _saveInlineToolbarSelection();
                  if (command === "color") applyInlineColor("red");
                  if (command === "code") applyInlineCode();
                  if (command === "bold")
                    await document
                      .querySelector('#inline-toolbar [data-cmd="bold"]')
                      .onclick();
                  if (command === "link") await promptForInlineLink();
                  const displayed = target.innerHTML;
                  renderEditor();
                  const restored = document.querySelector(selector).innerHTML;
                  undo();
                  const undone = document.querySelector(selector)?.innerHTML;
                  rows.push({
                    selector,
                    command,
                    changed: displayed !== "sample",
                    persisted: restored === displayed,
                    undone,
                  });
                }
              }
            } finally {
              document.execCommand = originalExec;
              showPrompt = originalPrompt;
            }
            return rows;
          }),
        );
        assert.equal(rows.length, 16);
        for (const row of rows)
          assert.deepEqual(row, {
            selector: row.selector,
            command: row.command,
            changed: true,
            persisted: true,
            undone: "sample",
          });
      },
    },
    {
      name: "complete: failed images keep the existing replacement action and caption",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const draft = window.__LeafNoteTest.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("image", "", {
                url: "data:image/png;base64,iVBORw0KGgo=",
                caption: "keep caption",
              }),
            ];
            window.__LeafNoteTest.setState(draft);
            renderAll();
            const img = document.querySelector(".image-wrap img"),
              button = document.querySelector(".image-replace-btn");
            img.dispatchEvent(new Event("error"));
            img.dispatchEvent(new Event("error"));
            const original = openImagePicker;
            let opened = 0;
            try {
              openImagePicker = () => {
                opened++;
              };
              document.querySelector(".image-replace-btn")?.click();
            } finally {
              openImagePicker = original;
            }
            return {
              sameButton:
                document.querySelector(".image-replace-btn") === button,
              opened,
              errors: document.querySelectorAll(".image-wrap .image-empty")
                .length,
              caption: document.querySelector(".image-caption").textContent,
              content: getCurrentPage().blocks[0].caption,
            };
          }),
        );
        assert.deepEqual(result, {
          sameButton: true,
          opened: 1,
          errors: 1,
          caption: "keep caption",
          content: "keep caption",
        });
      },
    },
    {
      name: "complete: native block fields do not truncate active IME composition and commit at compositionend",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const draft = window.__LeafNoteTest.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("math", ""),
              blk("footnote", ""),
              blk("link_reference", ""),
              blk("decision", ""),
              blk("api_spec", ""),
              blk("db_table", ""),
            ];
            // これらの互換用操作部品は、取り込んだブロックでも引き続き利用できる。
            state = draft;
            renderAll();
            const fields = Array.from(
              document.querySelectorAll(
                '#blocks input:not([type="date"]), #blocks textarea',
              ),
            );
            return fields.map((target) => {
              const limit = target.classList.contains("raw-block-textarea")
                ? RAW_TEXT_BLOCK_MAX_BYTES
                : TEXT_FIELD_MAX_CHARS;
              const value = "a".repeat(limit - 1) + "日本";
              target.focus();
              target.dispatchEvent(
                new CompositionEvent("compositionstart", { bubbles: true }),
              );
              target.value = value;
              target.dispatchEvent(
                new InputEvent("input", { bubbles: true, isComposing: true }),
              );
              const preserved = target.value === value;
              target.dispatchEvent(
                new CompositionEvent("compositionend", { bubbles: true }),
              );
              return {
                label: target.getAttribute("aria-label"),
                preserved,
                committed: target.value !== value,
                withinLimit: target.classList.contains("raw-block-textarea")
                  ? new TextEncoder().encode(target.value).length <= limit
                  : target.value.length <= limit,
              };
            });
          }),
        );
        assert.ok(rows.length >= 10);
        for (const row of rows)
          assert.deepEqual(row, {
            label: row.label,
            preserved: true,
            committed: true,
            withinLimit: true,
          });
      },
    },
    {
      name: "complete: native text field paste rejects overflow without losing its suffix",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(async () => {
            const draft = window.__LeafNoteTest.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("footnote", ""),
              blk("link_reference", ""),
              blk("decision", ""),
              blk("api_spec", ""),
              blk("db_table", ""),
            ];
            state = draft;
            renderAll();
            const fields = Array.from(
              document.querySelectorAll(
                '#blocks input:not([type="date"]), #blocks textarea:not(.raw-block-textarea)',
              ),
            );
            const originalAlert = showAlert;
            let alerts = 0;
            try {
              showAlert = async () => {
                alerts++;
              };
              const rows = [];
              for (const target of fields) {
                target.focus();
                target.value = "a".repeat(TEXT_FIELD_MAX_CHARS - 4) + "TAIL";
                target.dispatchEvent(new Event("input", { bubbles: true }));
                target.setSelectionRange(2, 2);
                const original = target.value,
                  beforeAlerts = alerts;
                const data = new DataTransfer();
                data.setData("text/plain", "overflow");
                const event = new ClipboardEvent("paste", {
                  bubbles: true,
                  cancelable: true,
                  clipboardData: data,
                });
                target.dispatchEvent(event);
                await new Promise((resolve) => setTimeout(resolve, 0));
                rows.push({
                  label: target.getAttribute("aria-label"),
                  prevented: event.defaultPrevented,
                  preserved: target.value === original,
                  warned: alerts > beforeAlerts,
                });
              }
              return rows;
            } finally {
              showAlert = originalAlert;
            }
          }),
        );
        assert.ok(rows.length >= 8);
        for (const row of rows)
          assert.deepEqual(row, {
            label: row.label,
            prevented: true,
            preserved: true,
            warned: true,
          });
      },
    },
    {
      name: "complete: large native paste restores its original replacement selection after confirmation",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const draft = window.__LeafNoteTest.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("math", "prefix SELECT suffix"),
            ];
            window.__LeafNoteTest.setState(draft);
            renderAll();
            const target = document.querySelector("textarea");
            target.focus();
            target.setSelectionRange(7, 13, "backward");
            const data = new DataTransfer(),
              pasted = "v".repeat(CLIPBOARD_PASTE_WARN_BYTES + 1);
            data.setData("text/plain", pasted);
            const pending = handlePlainTextLimitPaste(
              {
                currentTarget: target,
                clipboardData: data,
                preventDefault() {},
              },
              () => target.dispatchEvent(new Event("input", { bubbles: true })),
            );
            // フォーカスがダイアログへ移ったときに、ブラウザが入力欄の選択を失う状況を再現する。
            target.setSelectionRange(0, 0);
            document.querySelector("#dialog-overlay [data-ok]").click();
            await pending;
            return {
              valueMatches: target.value === "prefix " + pasted + " suffix",
              stateMatches: getCurrentPage().blocks[0].content === target.value,
              focused: document.activeElement === target,
              caret: target.selectionStart,
              expectedCaret: 7 + pasted.length,
            };
          }),
        );
        assert.deepEqual(result, {
          valueMatches: true,
          stateMatches: true,
          focused: true,
          caret: result.expectedCaret,
          expectedCaret: result.expectedCaret,
        });
      },
    },
    {
      name: "complete: native textarea paste participates in browser Undo and Redo",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const draft = window.__LeafNoteTest.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("math", "before after"),
            ];
            window.__LeafNoteTest.setState(draft);
            renderAll();
            const target = document.querySelector("textarea");
            target.focus();
            target.setSelectionRange(7, 7);
            const data = new DataTransfer();
            data.setData("text/plain", "pasted ");
            await handlePlainTextLimitPaste(
              {
                currentTarget: target,
                clipboardData: data,
                preventDefault() {},
              },
              () => target.dispatchEvent(new Event("input", { bubbles: true })),
            );
            const pasted = target.value;
            document.execCommand("undo");
            const undone = target.value,
              undoState = getCurrentPage().blocks[0].content;
            document.execCommand("redo");
            return {
              pasted,
              undone,
              undoState,
              redone: target.value,
              redoState: getCurrentPage().blocks[0].content,
            };
          }),
        );
        assert.deepEqual(result, {
          pasted: "before pasted after",
          undone: "before after",
          undoState: "before after",
          redone: "before pasted after",
          redoState: "before pasted after",
        });
      },
    },
  ];
}
