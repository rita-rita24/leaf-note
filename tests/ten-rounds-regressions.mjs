import assert from "node:assert/strict";

export function createTenRoundTests({ evaluate, js }) {
  return [
    {
      name: "round 10: Markdown typing shortcuts retain rich suffixes and line breaks",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              rows = [];
            for (const [prefix, type] of [
              ["# ", "h1"],
              ["## ", "h2"],
              ["- ", "bullet"],
              ["[] ", "todo"],
              ["> ", "quote"],
              ['" ', "quote"],
            ]) {
              const draft = api.createInitialState();
              draft.pages[draft.currentPageId].blocks = [
                blk("text", "<b>keep</b><br><i>suffix</i>"),
              ];
              api.setState(draft);
              api.renderAll();
              const target = document.querySelector("[data-block-id]");
              target.focus();
              target.innerHTML =
                "<span>" +
                escapeHTML(prefix[0]) +
                "</span>" +
                escapeHTML(prefix.slice(1)) +
                target.innerHTML;
              target.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  data: " ",
                  inputType: "insertText",
                }),
              );
              const block = getCurrentPage().blocks[0],
                content = document.querySelector("[data-block-id]");
              rows.push({
                expected: type,
                actual: block.type,
                text: content.textContent,
                bold: content.querySelector("b")?.textContent,
                italic: content.querySelector("i")?.textContent,
                breaks: content.querySelectorAll("br").length,
                stored: block.content === content.innerHTML,
              });
            }
            return rows;
          }),
        );
        for (const row of result)
          assert.deepEqual(row, {
            expected: row.expected,
            actual: row.expected,
            text: "keepsuffix",
            bold: "keep",
            italic: "suffix",
            breaks: 1,
            stored: true,
          });
      },
    },
    {
      name: "round 9: export fetches release their abort signals on every completion path",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const originalFetch = window.fetch,
              rows = [];
            const cases = [
              ["image", "http", 503, "image/png", "error", null],
              ["image", "size", 200, "image/png", "image", "999"],
              ["image", "type", 200, "text/plain", "not image", null],
              ["image", "success", 200, "image/png", "image", null],
              ["html", "http", 503, "text/html", "error", null],
              ["html", "size", 200, "text/html", "source", "999"],
              ["html", "type", 200, "text/plain", "not HTML", null],
              ["html", "invalid", 200, "text/html", "not LeafNote", null],
              [
                "html",
                "success",
                200,
                "text/html",
                '<script id="embedded-state"></script><div id="export-btn"></div><div id="blocks">LeafNote</div>',
                null,
              ],
            ];
            try {
              for (const [kind, outcome, status, type, body, length] of cases) {
                let signal,
                  failed = false;
                window.fetch = async (_url, options) => {
                  signal = options.signal;
                  const headers = { "content-type": type };
                  if (length) headers["content-length"] = length;
                  return new Response(body, { status, headers });
                };
                try {
                  if (kind === "image")
                    await fetchRemoteImageBlob(
                      "https://example.com/image.png",
                      { maxBytes: 128 },
                    );
                  else
                    await fetchSelfHtmlForExport(
                      "https://example.com/LeafNote.html",
                      { maxBytes: 128 },
                    );
                } catch {
                  failed = true;
                }
                rows.push({
                  kind,
                  outcome,
                  failed,
                  released: signal?.aborted === true,
                });
              }
            } finally {
              window.fetch = originalFetch;
            }
            return rows;
          }),
        );
        assert.equal(result.length, 9);
        for (const row of result) {
          assert.equal(
            row.failed,
            row.outcome !== "success",
            JSON.stringify(row),
          );
          assert.equal(row.released, true, JSON.stringify(row));
        }
      },
    },
    {
      name: "round 8: ordinary typing does not rebuild numbered prefixes and structural edits still renumber",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("text", "body"),
              ...Array.from({ length: 20 }, (_, i) =>
                blk("numbered", String(i)),
              ),
            ];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelector("[data-block-id]");
            target.focus();
            const observer = new MutationObserver(() => {});
            observer.observe(document.querySelector("#blocks"), {
              childList: true,
              subtree: true,
            });
            for (let i = 0; i < 30; i++) {
              target.textContent += "a";
              target.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  inputType: "insertText",
                  data: "a",
                }),
              );
            }
            const prefixWrites = observer
              .takeRecords()
              .filter((record) =>
                record.target.classList?.contains("block-prefix"),
              ).length;
            observer.disconnect();
            convertBlockType(getCurrentPage().blocks[0], "numbered");
            return {
              prefixWrites,
              numbers: [
                ...document.querySelectorAll("#blocks .block-prefix"),
              ].map((el) => el.textContent),
              content: getCurrentPage().blocks[0].content,
            };
          }),
        );
        assert.equal(result.prefixWrites, 0);
        assert.deepEqual(
          result.numbers,
          Array.from({ length: 21 }, (_, i) => `${i + 1}.`),
        );
        assert.equal(result.content, "body" + "a".repeat(30));
      },
    },
    {
      name: "round 7: rich text and table input preserve composing nodes until commit",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              rows = [];
            for (const type of ["text", "table", "decision", "image"]) {
              const draft = api.createInitialState();
              const block =
                type === "table"
                  ? blk(type, "", { rows: 1, cols: 1, cells: [["before"]] })
                  : type === "image"
                    ? blk(type, "", {
                        url: "data:image/png;base64,iVBORw0KGgo=",
                        caption: "before",
                      })
                    : blk(type, "before");
              draft.pages[draft.currentPageId].blocks = [block];
              api.setState(draft);
              api.renderAll();
              const target = document.querySelector(
                '#blocks [contenteditable="true"]',
              );
              target.focus();
              target.innerHTML = '<span class="ime-transient">日本語</span>';
              const node = target.firstChild;
              getSelection().setBaseAndExtent(
                node.firstChild,
                3,
                node.firstChild,
                3,
              );
              target.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  isComposing: true,
                  inputType: "insertCompositionText",
                }),
              );
              const retained = target.firstChild === node && node.isConnected;
              target.dispatchEvent(
                new CompositionEvent("compositionend", {
                  bubbles: true,
                  data: "日本語",
                }),
              );
              const stored =
                type === "table"
                  ? block.cells[0][0]
                  : type === "image"
                    ? block.caption
                    : block.content;
              rows.push({
                type,
                retained,
                sanitized: !target.querySelector("[class]"),
                text: target.textContent,
                stored: stripHTMLToText(stored),
              });
            }
            return rows;
          }),
        );
        assert.deepEqual(
          result,
          ["text", "table", "decision", "image"].map((type) => ({
            type,
            retained: true,
            sanitized: true,
            text: "日本語",
            stored: "日本語",
          })),
        );
      },
    },
    {
      name: "round 6: clipboard fallback preserves backward selections and cleans up after failure",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [blk("text", "abcdef")];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelector("[data-block-id]"),
              originalExec = document.execCommand,
              rows = [];
            const before = document.querySelectorAll("textarea").length;
            try {
              for (const outcome of ["success", "failure", "throw"]) {
                target.focus();
                getSelection().setBaseAndExtent(
                  target.firstChild,
                  5,
                  target.firstChild,
                  1,
                );
                document.execCommand = () => {
                  if (outcome === "throw") throw new Error("denied");
                  return outcome === "success";
                };
                const copied = _copyTextViaExecCommand("copied text"),
                  selection = getSelection();
                rows.push({
                  copied,
                  anchor: selection.anchorOffset,
                  focus: selection.focusOffset,
                  text: selection.toString(),
                  active: document.activeElement === target,
                  clean:
                    document.querySelectorAll("textarea").length === before,
                });
              }
            } finally {
              document.execCommand = originalExec;
            }
            return rows;
          }),
        );
        assert.deepEqual(
          result,
          [true, false, false].map((copied) => ({
            copied,
            anchor: 5,
            focus: 1,
            text: "bcde",
            active: true,
            clean: true,
          })),
        );
      },
    },
    {
      name: "round 5: title and document-name paste never truncate existing suffixes",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            api.renderAll();
            const originalAlert = showAlert,
              rows = [];
            let alerts = 0;
            try {
              showAlert = async () => {
                alerts++;
              };
              for (const selector of ["#page-title", "#document-name"]) {
                const target = document.querySelector(selector),
                  original = "x".repeat(TEXT_FIELD_MAX_CHARS - 2);
                target.focus();
                target.textContent = original;
                target.dispatchEvent(new Event("input", { bubbles: true }));
                placeCaret(target, "start");
                const data = new DataTransfer();
                data.setData("text/plain", "overflow");
                const sync = () =>
                  target.dispatchEvent(new Event("input", { bubbles: true }));
                await handlePlainTextEditablePaste(
                  {
                    clipboardData: data,
                    currentTarget: target,
                    preventDefault() {},
                  },
                  sync,
                );
                const preserved =
                  target.textContent === original &&
                  (selector === "#page-title"
                    ? getCurrentPage().title
                    : state.workspaceName) === original;
                getSelection().setBaseAndExtent(
                  target.firstChild,
                  0,
                  target.firstChild,
                  8,
                );
                await handlePlainTextEditablePaste(
                  {
                    clipboardData: data,
                    currentTarget: target,
                    preventDefault() {},
                  },
                  sync,
                );
                rows.push({
                  preserved,
                  replaced:
                    target.textContent === "overflow" + original.slice(8),
                });
              }
              return { rows, alerts };
            } finally {
              showAlert = originalAlert;
            }
          }),
        );
        assert.deepEqual(result, {
          rows: [
            { preserved: true, replaced: true },
            { preserved: true, replaced: true },
          ],
          alerts: 2,
        });
      },
    },
    {
      name: "round 4: text limits never split Unicode surrogate pairs",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const cases = [
              "😀",
              "A😀B",
              "日本語🚀末尾",
              "a".repeat(TEXT_FIELD_MAX_CHARS - 1) + "😀",
            ];
            let checked = 0;
            for (const value of cases) {
              for (const limit of [
                0,
                1,
                2,
                3,
                4,
                5,
                6,
                7,
                TEXT_FIELD_MAX_CHARS,
              ]) {
                let expected = "";
                for (const char of value) {
                  if (expected.length + char.length > limit) break;
                  expected += char;
                }
                const actual = _truncateStringByChars(value, limit);
                if (
                  actual.value !== expected ||
                  actual.truncated !== (value !== expected)
                )
                  return {
                    failed: {
                      limit,
                      value: value.slice(-10),
                      actual: actual.value.slice(-10),
                    },
                  };
                checked++;
              }
            }
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            api.renderAll();
            const title = document.querySelector("#page-title");
            title.textContent = cases[3];
            title.dispatchEvent(new InputEvent("input", { bubbles: true }));
            const stored = getCurrentPage().title;
            return {
              checked,
              titleLength: stored.length,
              intact: stored === "a".repeat(TEXT_FIELD_MAX_CHARS - 1),
              dom: title.textContent === stored,
            };
          }),
        );
        assert.deepEqual(result, {
          checked: 36,
          titleLength: 4095,
          intact: true,
          dom: true,
        });
      },
    },
    {
      name: "round 3: code indentation preserves full fields and modified Tab keeps native navigation",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            const original = "x".repeat(RAW_TEXT_BLOCK_MAX_BYTES - 1);
            draft.pages[draft.currentPageId].blocks = [blk("code", original)];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelector("code[data-block-id]");
            target.focus();
            placeCaret(target, "start");
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Tab",
                bubbles: true,
                cancelable: true,
              }),
            );
            const preserved =
              target.textContent === original &&
              getCurrentPage().blocks[0].content === original;
            const modified = ["shiftKey", "ctrlKey", "metaKey", "altKey"].map(
              (modifier) => {
                const event = new KeyboardEvent("keydown", {
                  key: "Tab",
                  [modifier]: true,
                  bubbles: true,
                  cancelable: true,
                });
                target.dispatchEvent(event);
                return event.defaultPrevented;
              },
            );
            target.textContent = "abCD";
            getSelection().setBaseAndExtent(
              target.firstChild,
              2,
              target.firstChild,
              4,
            );
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Tab",
                bubbles: true,
                cancelable: true,
              }),
            );
            return {
              preserved,
              modified,
              replaced: target.textContent,
              stored: getCurrentPage().blocks[0].content,
            };
          }),
        );
        assert.deepEqual(result, {
          preserved: true,
          modified: [false, false, false, false],
          replaced: "ab  ",
          stored: "ab  ",
        });
      },
    },
    {
      name: "round 2: line breaks count as content at caret boundaries",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("text", "previous"),
              blk("text", "<br>body<br>"),
              blk("text", "next"),
            ];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelectorAll("[data-block-id]")[1];
            target.focus();
            getSelection().setBaseAndExtent(target, 1, target, 1);
            const start = isCaretAtStart(target);
            const backspace = new KeyboardEvent("keydown", {
              key: "Backspace",
              bubbles: true,
              cancelable: true,
            });
            target.dispatchEvent(backspace);
            getSelection().setBaseAndExtent(target, 2, target, 2);
            const end = isCaretAtEnd(target);
            const down = new KeyboardEvent("keydown", {
              key: "ArrowDown",
              bubbles: true,
              cancelable: true,
            });
            target.dispatchEvent(down);
            const other = document.querySelector("#page-title");
            other.focus();
            placeCaret(other, "start");
            return {
              start,
              end,
              backspace: backspace.defaultPrevented,
              down: down.defaultPrevented,
              count: getCurrentPage().blocks.length,
              outsideStart: isCaretAtStart(target),
              outsideEnd: isCaretAtEnd(target),
            };
          }),
        );
        assert.deepEqual(result, {
          start: false,
          end: false,
          backspace: false,
          down: false,
          count: 3,
          outsideStart: false,
          outsideEnd: false,
        });
      },
    },
    {
      name: "round 1: modified arrow keys retain native selection and paragraph navigation",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("text", "first"),
              blk("text", "middle"),
              blk("text", "last"),
            ];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelectorAll("[data-block-id]")[1];
            return ["shiftKey", "ctrlKey", "metaKey", "altKey"].flatMap(
              (modifier) =>
                ["ArrowUp", "ArrowDown"].map((key) => {
                  target.focus();
                  placeCaret(target, key === "ArrowUp" ? "start" : "end");
                  const event = new KeyboardEvent("keydown", {
                    key,
                    [modifier]: true,
                    bubbles: true,
                    cancelable: true,
                  });
                  target.dispatchEvent(event);
                  return {
                    prevented: event.defaultPrevented,
                    focus: document.activeElement === target,
                  };
                }),
            );
          }),
        );
        assert.deepEqual(
          result,
          Array(8).fill({ prevented: false, focus: true }),
        );
      },
    },
  ];
}
