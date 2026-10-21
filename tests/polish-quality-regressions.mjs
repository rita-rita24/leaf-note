import assert from "node:assert/strict";

export function createPolishQualityTests({ evaluate, js }) {
  return [
    {
      name: "polish: large or complex Markdown fallback preserves every line break and trailing text",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const cases = [
              "x".repeat(HTML_TO_MARKDOWN_MAX_OUTPUT_CHARS + 1) + "<br>TAIL",
              "<b>row</b><br>".repeat(HTML_TO_MARKDOWN_MAX_DOM_NODES) + "TAIL",
            ];
            return cases.map((html) => {
              const expected = stripHTMLToText(html),
                actual = htmlToMarkdownInline(html);
              return {
                matches: actual === expected,
                expectedLines: expected.split("\n").length,
                actualLines: actual.split("\n").length,
                tail: actual.endsWith("TAIL"),
              };
            });
          }),
        );
        for (const row of rows) {
          assert.equal(row.matches, true);
          assert.equal(row.actualLines, row.expectedLines);
          assert.equal(row.tail, true);
        }
      },
    },
    {
      name: "polish: changing related specification and governance types retains all original visible data",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const rows = [];
            for (const [from, to, extra, markers] of [
              [
                "api_spec",
                "screen_spec",
                {
                  endpoint: "/api/keep",
                  requestBody: "request-marker",
                  responseBody: "response-marker",
                },
                ["/api/keep", "request-marker", "response-marker"],
              ],
              [
                "db_table",
                "test_case",
                {
                  tableName: "accounts-marker",
                  columns: [
                    {
                      name: "email-marker",
                      type: "text",
                      key: "UK",
                      nullable: "No",
                      description: "keep-column",
                    },
                  ],
                },
                ["accounts-marker", "email-marker", "keep-column"],
              ],
              [
                "decision",
                "requirement",
                {
                  governanceStatus: "accepted",
                  governanceDate: "2026-09-23",
                  governanceOwner: "owner-marker",
                },
                ["accepted", "2026-09-23", "owner-marker"],
              ],
              [
                "open_question",
                "risk",
                {
                  governanceStatus: "answered",
                  governanceDue: "2026-09-24",
                  governanceOwner: "owner-marker",
                },
                ["answered", "2026-09-24", "owner-marker"],
              ],
            ]) {
              const draft = createInitialState();
              draft.pages[draft.currentPageId].blocks = [
                blk(from, "body-marker", extra),
              ];
              window.__LeafNoteTest.setState(draft);
              renderAll();
              const original = JSON.stringify(getCurrentPage().blocks);
              convertBlockType(getCurrentPage().blocks[0], to);
              const blocks = getCurrentPage().blocks;
              const visible = flattenTextFromBlocks(blocks);
              const clean = SPEC_BLOCK_TYPES.has(to)
                ? !blocks[0].endpoint &&
                  !blocks[0].tableName &&
                  !blocks[0].columns
                : true;
              const stable =
                normalizeStateShape(state).state.pages[state.currentPageId]
                  .blocks;
              const preserved = markers.every(
                (marker) =>
                  visible.includes(marker) &&
                  flattenTextFromBlocks(stable).includes(marker),
              );
              const converted = blocks[0].type === to;
              undo();
              rows.push({
                from,
                to,
                converted,
                preserved,
                clean,
                undo: JSON.stringify(getCurrentPage().blocks) === original,
              });
            }
            return rows;
          }),
        );
        for (const row of rows)
          assert.deepEqual(row, {
            from: row.from,
            to: row.to,
            converted: true,
            preserved: true,
            clean: true,
            undo: true,
          });
      },
    },
    {
      name: "polish: oversized conversion keeps the complete source and history without partial truncation",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const rows = [],
              originalAlert = showAlert;
            try {
              showAlert = async () => {};
              const cases = [
                blk("table", "", {
                  rows: 1,
                  cols: 2,
                  cells: [["a".repeat(600000), "b".repeat(600000) + "TAIL"]],
                }),
                blk("code", "&".repeat(220000)),
                blk(
                  "decision",
                  "x".repeat(RICH_HTML_FIELD_MAX_BYTES - 8) + "TAIL",
                  { governanceOwner: "owner-marker" },
                ),
              ];
              for (const [index, source] of cases.entries()) {
                const draft = createInitialState();
                draft.pages[draft.currentPageId].blocks = [source];
                window.__LeafNoteTest.setState(draft);
                const before = JSON.stringify(state),
                  history = JSON.stringify([
                    undoStack,
                    redoStack,
                    _pendingSnapshot,
                  ]);
                convertBlockType(
                  getCurrentPage().blocks[0],
                  index === 1 ? "table" : "text",
                );
                rows.push({
                  index,
                  intact: JSON.stringify(state) === before,
                  historyIntact:
                    JSON.stringify([undoStack, redoStack, _pendingSnapshot]) ===
                    history,
                });
              }
            } finally {
              showAlert = originalAlert;
            }
            return rows;
          }),
        );
        for (const row of rows)
          assert.deepEqual(row, {
            index: row.index,
            intact: true,
            historyIntact: true,
          });
      },
    },
    {
      name: "polish: keyboard navigation focuses existing raw, table, image and specification fields",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const rows = [];
            for (const [type, extra, selector] of [
              ["math", {}, ".raw-block-textarea"],
              [
                "table",
                { rows: 1, cols: 1, cells: [["cell"]] },
                ".simple-table th",
              ],
              [
                "image",
                {
                  url: "data:image/png;base64,iVBORw0KGgo=",
                  caption: "caption",
                },
                ".image-caption",
              ],
              ["api_spec", { specTitle: "title" }, ".spec-field input"],
            ]) {
              const draft = createInitialState();
              draft.pages[draft.currentPageId].blocks = [
                blk(type, "abc", extra),
              ];
              window.__LeafNoteTest.setState(draft);
              renderAll();
              const block = getCurrentPage().blocks[0];
              for (const position of ["start", "end"]) {
                titleEl.focus();
                focusBlock(block.id, position);
                const field = document.querySelector(selector);
                const focused = document.activeElement === field;
                const native = typeof field?.value === "string";
                const caret = native
                  ? field.selectionStart
                  : _captureRichSelectionOffsets(field)?.anchor;
                const expected =
                  position === "start"
                    ? 0
                    : native
                      ? field.value.length
                      : _richFragmentLength(field);
                rows.push({ type, position, focused, caret, expected });
              }
            }
            return rows;
          }),
        );
        for (const row of rows) {
          assert.equal(row.focused, true, `${row.type} ${row.position}`);
          assert.equal(row.caret, row.expected, row.type);
        }
      },
    },
    {
      name: "polish: modified Backspace leaves block structure to native text editing",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const rows = [];
            for (const type of ["text", "h2", "code"]) {
              for (const key of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) {
                const draft = createInitialState();
                draft.pages[draft.currentPageId].blocks = [
                  blk("text", "previous"),
                  blk(type, type === "code" ? "" : "keep"),
                ];
                window.__LeafNoteTest.setState(draft);
                renderAll();
                const block = getCurrentPage().blocks[1],
                  target = document.querySelector(
                    blockEditableSelectorById(block.id),
                  );
                target.focus();
                placeCaret(target, "start");
                const before = JSON.stringify(getCurrentPage().blocks);
                const event = new KeyboardEvent("keydown", {
                  key: "Backspace",
                  [key]: true,
                  bubbles: true,
                  cancelable: true,
                });
                target.dispatchEvent(event);
                rows.push({
                  type,
                  key,
                  prevented: event.defaultPrevented,
                  intact: JSON.stringify(getCurrentPage().blocks) === before,
                });
              }
            }
            return rows;
          }),
        );
        for (const row of rows)
          assert.deepEqual(row, {
            type: row.type,
            key: row.key,
            prevented: false,
            intact: true,
          });
      },
    },
    {
      name: "polish: Unicode case folding highlights the matching original characters without duplication",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            return [
              ["İstanbul test test", "test", ["test", "test"]],
              ["İABC", "i", ["İ"]],
              ["😀İZ <tag>", "z", ["Z"]],
              ["İİİ", "i", ["İ", "İ", "İ"]],
              ["日本語 & ABC", "abc", ["ABC"]],
            ].map(([text, query, expected]) => {
              const holder = document.createElement("div");
              holder.innerHTML = highlightMatch(text, query);
              return {
                text,
                query,
                expected,
                rendered: holder.textContent,
                hits: Array.from(holder.querySelectorAll(".search-hit")).map(
                  (el) => el.textContent,
                ),
                unsafe: !!holder.querySelector("tag"),
              };
            });
          }),
        );
        for (const row of rows) {
          assert.equal(row.rendered, row.text, row.query);
          assert.deepEqual(row.hits, row.expected);
          assert.equal(row.unsafe, false);
        }
      },
    },
    {
      name: "polish: search defers composition and cancels hidden result updates",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const draft = window.__LeafNoteTest.createInitialState();
            draft.pages[draft.currentPageId].blocks = Array.from(
              { length: 40 },
              (_, index) => blk("text", "日本 " + index),
            );
            window.__LeafNoteTest.setState(draft);
            renderAll();
            openSearchModal("before");
            await new Promise((resolve) => setTimeout(resolve, 60));
            const first = searchResults.firstElementChild;
            searchInput.value = "pending";
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            searchInput.dispatchEvent(
              new CompositionEvent("compositionstart", { bubbles: true }),
            );
            searchInput.value = "にほん";
            searchInput.dispatchEvent(
              new InputEvent("input", { bubbles: true, isComposing: true }),
            );
            await new Promise((resolve) =>
              setTimeout(resolve, SEARCH_INPUT_DEBOUNCE_MS + 30),
            );
            const unchanged = searchResults.firstElementChild === first;
            searchInput.value = "日本";
            searchInput.dispatchEvent(
              new CompositionEvent("compositionend", { bubbles: true }),
            );
            await new Promise((resolve) =>
              setTimeout(resolve, SEARCH_INPUT_DEBOUNCE_MS + 30),
            );
            const committed = searchResults.textContent.includes("日本");
            const current = searchResults.firstElementChild;
            searchInput.value = "closed";
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            closeOverlay(searchOverlay);
            await new Promise((resolve) =>
              setTimeout(resolve, SEARCH_INPUT_DEBOUNCE_MS + 30),
            );
            return {
              unchanged,
              committed,
              hiddenUnchanged: searchResults.firstElementChild === current,
              timerCleared: _searchRenderTimer === null,
            };
          }),
        );
        assert.deepEqual(result, {
          unchanged: true,
          committed: true,
          hiddenUnchanged: true,
          timerCleared: true,
        });
      },
    },
    {
      name: "polish: image alternative text follows the readable caption through editing and paste",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const draft = createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              blk("image", "", {
                url: "data:image/png;base64,iVBORw0KGgo=",
                caption: "<b>caption</b> &amp; text",
              }),
            ];
            window.__LeafNoteTest.setState(draft);
            renderAll();
            const img = document.querySelector(".image-wrap img"),
              caption = document.querySelector(".image-caption");
            const initial = img.alt;
            caption.innerHTML = "<i>edited</i><br>next";
            caption.dispatchEvent(new Event("input", { bubbles: true }));
            const edited = img.alt;
            caption.focus();
            placeCaret(caption, "end");
            const data = new DataTransfer();
            data.setData("text/html", "<b> pasted</b>");
            caption.dispatchEvent(
              new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData: data,
              }),
            );
            await Promise.resolve();
            return {
              initial,
              edited,
              pasted: img.alt,
              state: stripHTMLToText(getCurrentPage().blocks[0].caption),
            };
          }),
        );
        assert.deepEqual(result, {
          initial: "caption & text",
          edited: "edited\nnext",
          pasted: "edited\nnext pasted",
          state: "edited\nnext pasted",
        });
      },
    },
  ];
}
