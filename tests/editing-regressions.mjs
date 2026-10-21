import assert from "node:assert/strict";

export function createEditingTests({ evaluate, js }) {
  return [
    {
      name: "editing: rich body and table pastes preserve existing content when the joined field exceeds its limit",
      run: async (page) => {
        const results = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              results = [],
              originalAlert = showAlert;
            try {
              showAlert = async () => true;
              for (const type of ["text", "table"]) {
                const draft = api.createInitialState(),
                  original = "x".repeat(RICH_HTML_FIELD_MAX_BYTES - 4);
                draft.pages[draft.currentPageId].blocks = [
                  type === "text"
                    ? blk("text", original)
                    : blk("table", "", {
                        rows: 1,
                        cols: 1,
                        cells: [[original]],
                      }),
                ];
                api.setState(draft);
                api.renderAll();
                const target = document.querySelector(
                  type === "text" ? "[data-block-id]" : ".simple-table th",
                );
                target.focus();
                placeCaret(target, "end");
                const data = new DataTransfer();
                data.setData("text/html", "<b>overflow</b>");
                const event = {
                  clipboardData: data,
                  currentTarget: target,
                  preventDefault() {},
                };
                const block = getCurrentPage().blocks[0];
                if (type === "text")
                  await handleBlockPaste(event, block, target);
                else
                  await handleSanitizedRichPaste(event, () => {
                    block.cells[0][0] = _normalizeRichEditableContent(target);
                  });
                results.push({
                  type,
                  dom: target.textContent === original,
                  stored:
                    (type === "text" ? block.content : block.cells[0][0]) ===
                    original,
                });
              }
            } finally {
              showAlert = originalAlert;
            }
            return results;
          }),
        );
        assert.deepEqual(results, [
          { type: "text", dom: true, stored: true },
          { type: "table", dom: true, stored: true },
        ]);
      },
    },
    {
      name: "editing: multiline paste handles empty boundary lines and Undo restores the whole original",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("text", "beforeAFTER"),
            ];
            api.setState(draft);
            api.renderAll();
            const original = JSON.stringify(getCurrentPage().blocks);
            const target = document.querySelector("[data-block-id]");
            target.focus();
            setCaretByTextOffset(target, 6);
            const data = new DataTransfer();
            data.setData("text/plain", "\n\n");
            await handleBlockPaste(
              {
                clipboardData: data,
                currentTarget: target,
                preventDefault() {},
              },
              getCurrentPage().blocks[0],
              target,
            );
            const pasted = getCurrentPage().blocks.map((block) =>
              stripHTMLToText(block.content),
            );
            const caret = getCaretTextOffset(document.activeElement);
            undo();
            const restored =
              JSON.stringify(getCurrentPage().blocks) === original;
            redo();
            return {
              pasted,
              caret,
              restored,
              redone: getCurrentPage().blocks.map((block) =>
                stripHTMLToText(block.content),
              ),
            };
          }),
        );
        assert.deepEqual(result, {
          pasted: ["before", "", "AFTER"],
          caret: 0,
          restored: true,
          redone: ["before", "", "AFTER"],
        });
      },
    },
    {
      name: "editing: sanitizing rich text keeps the caret on the same side of a line break",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [blk("text", "line")];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelector("[data-block-id]");
            target.focus();
            return [1, 2].map((offset) => {
              target.innerHTML =
                '<span class="remove">A</span><br><span>B</span>';
              getSelection().setBaseAndExtent(target, offset, target, offset);
              _normalizeRichEditableContent(target);
              const range = getSelection().getRangeAt(0).cloneRange();
              range.selectNodeContents(target);
              range.setEnd(
                getSelection().anchorNode,
                getSelection().anchorOffset,
              );
              const part = range.cloneContents();
              return {
                text: part.textContent,
                breaks: part.querySelectorAll("br").length,
              };
            });
          }),
        );
        assert.deepEqual(result, [
          { text: "A", breaks: 0 },
          { text: "A", breaks: 1 },
        ]);
      },
    },
    {
      name: "editing: title and document name accept spaces and complete deletion while typing",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            api.renderAll();
            const type = (target, text) => {
              target.focus();
              target.textContent = "";
              target.dispatchEvent(new InputEvent("input", { bubbles: true }));
              const empty = target.textContent;
              for (const char of text) {
                target.append(document.createTextNode(char));
                target.dispatchEvent(
                  new InputEvent("input", {
                    bubbles: true,
                    data: char,
                    inputType: "insertText",
                  }),
                );
              }
              const value = target.textContent;
              target.blur();
              return { empty, value };
            };
            const title = type(
              document.querySelector("#page-title"),
              "Meeting notes 日本語",
            );
            const name = type(
              document.querySelector("#document-name"),
              "My notes 日本語",
            );
            return {
              title,
              name,
              storedTitle:
                api.getState().pages[api.getState().currentPageId].title,
              storedName: api.getState().workspaceName,
            };
          }),
        );
        assert.deepEqual(result, {
          title: { empty: "", value: "Meeting notes 日本語" },
          name: { empty: "", value: "My notes 日本語" },
          storedTitle: "Meeting notes 日本語",
          storedName: "My notes 日本語",
        });
      },
    },
    {
      name: "editing: multiline paste preserves selected replacement order, rich suffix and caret",
      run: async (page) => {
        const results = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest,
              results = [];
            for (const newline of ["\n", "\r\n", "\r"]) {
              const draft = api.createInitialState();
              draft.pages[draft.currentPageId].blocks = [
                blk("text", "<b>abc</b><i>DEF</i><u>ghi</u>"),
              ];
              api.setState(draft);
              api.renderAll();
              const target = document.querySelector("[data-block-id]");
              target.focus();
              const range = document.createRange();
              range.selectNodeContents(target.querySelector("i"));
              getSelection().removeAllRanges();
              getSelection().addRange(range);
              const data = new DataTransfer();
              data.setData("text/plain", `One${newline}Two${newline}Three`);
              await handleBlockPaste(
                {
                  clipboardData: data,
                  currentTarget: target,
                  preventDefault() {},
                },
                getCurrentPage().blocks[0],
                target,
              );
              const blocks = getCurrentPage().blocks;
              results.push({
                text: blocks.map((block) => stripHTMLToText(block.content)),
                richSuffix: blocks.at(-1).content.includes("<u>ghi</u>"),
                caret: getCaretTextOffset(document.activeElement),
              });
            }
            return results;
          }),
        );
        for (const result of results)
          assert.deepEqual(result, {
            text: ["abcOne", "Two", "Threeghi"],
            richSuffix: true,
            caret: 5,
          });
      },
    },
    {
      name: "editing: multiline paste rejects an overflowing joined field without partial edits",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("text", "x".repeat(RICH_HTML_FIELD_MAX_BYTES - 2)),
            ];
            api.setState(draft);
            api.renderAll();
            const original = JSON.stringify(getCurrentPage().blocks),
              originalAlert = showAlert;
            let alerts = 0;
            try {
              showAlert = async () => {
                alerts++;
              };
              const target = document.querySelector("[data-block-id]");
              target.focus();
              placeCaret(target, "end");
              const data = new DataTransfer();
              data.setData("text/plain", "overflow\nnext");
              await handleBlockPaste(
                {
                  clipboardData: data,
                  currentTarget: target,
                  preventDefault() {},
                },
                getCurrentPage().blocks[0],
                target,
              );
              return {
                unchanged: JSON.stringify(getCurrentPage().blocks) === original,
                domUnchanged:
                  target.textContent ===
                  "x".repeat(RICH_HTML_FIELD_MAX_BYTES - 2),
                alerts,
              };
            } finally {
              showAlert = originalAlert;
            }
          }),
        );
        assert.deepEqual(result, {
          unchanged: true,
          domUnchanged: true,
          alerts: 1,
        });
      },
    },
    {
      name: "editing: rich sanitization preserves backward selection and does not steal another fields caret",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("text", "abcdefgh"),
              blk("text", "second"),
            ];
            api.setState(draft);
            api.renderAll();
            const [first, second] =
              document.querySelectorAll("[data-block-id]");
            first.innerHTML = '<span class="unwanted">abcdefgh</span>';
            first.focus();
            getSelection().setBaseAndExtent(
              first.firstChild.firstChild,
              6,
              first.firstChild.firstChild,
              2,
            );
            _normalizeRichEditableContent(first);
            const selection = {
              text: getSelection().toString(),
              anchor: getSelection().anchorOffset,
              focus: getSelection().focusOffset,
            };
            second.innerHTML = '<span class="unwanted">second</span>';
            _normalizeRichEditableContent(second);
            return {
              selection,
              remained: first.contains(getSelection().anchorNode),
              after: getSelection().toString(),
              safe:
                !first.querySelector("[class]") &&
                !second.querySelector("[class]"),
            };
          }),
        );
        assert.deepEqual(result, {
          selection: { text: "cdef", anchor: 6, focus: 2 },
          remained: true,
          after: "cdef",
          safe: true,
        });
      },
    },
    {
      name: "editing: search Enter uses the latest query before its debounce fires",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            const first = getCurrentPage();
            first.title = "Previous result";
            const second = createPage(null, { title: "Requested result" });
            api.renderAll();
            openSearchModal("Previous");
            const input = document.querySelector("#search-input");
            input.value = "Requested";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
                cancelable: true,
              }),
            );
            return { expected: second.id, current: getCurrentPage().id };
          }),
        );
        assert.equal(result.current, result.expected);
      },
    },
    {
      name: "editing: formatting shortcuts leave IME composition and empty h4 Enter intact",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [blk("text", "日本語")];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelector("[data-block-id]");
            target.focus();
            placeCaret(target, "end");
            const originalExec = document.execCommand;
            let calls = 0;
            const event = new KeyboardEvent("keydown", {
              key: "b",
              ctrlKey: true,
              isComposing: true,
              bubbles: true,
              cancelable: true,
            });
            try {
              document.execCommand = () => {
                calls++;
                return true;
              };
              target.dispatchEvent(event);
            } finally {
              document.execCommand = originalExec;
            }
            getCurrentPage().blocks = [blk("h4", "")];
            renderEditor();
            const heading = document.querySelector("[data-block-id]");
            heading.focus();
            placeCaret(heading, "end");
            heading.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
                cancelable: true,
              }),
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              calls,
              prevented: event.defaultPrevented,
              types: getCurrentPage().blocks.map((block) => block.type),
            };
          }),
        );
        assert.deepEqual(result, {
          calls: 0,
          prevented: false,
          types: ["text"],
        });
      },
    },
  ];
}
