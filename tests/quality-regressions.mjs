import assert from "node:assert/strict";
import { createPageRestoreTests } from "./page-restore-regressions.mjs";
import { createUsabilityTests } from "./usability-regressions.mjs";
import { createEditingTests } from "./editing-regressions.mjs";
import { createInteractionTests } from "./interaction-regressions.mjs";
import { createTenRoundTests } from "./ten-rounds-regressions.mjs";
import { createSilentQualityTests } from "./silent-quality-regressions.mjs";
import { createCompleteQualityTests } from "./complete-quality-regressions.mjs";
import { createPolishQualityTests } from "./polish-quality-regressions.mjs";

export function createQualityTests({ evaluate, js }) {
  return [
    ...createPageRestoreTests({ evaluate, js }),
    ...createUsabilityTests({ evaluate, js }),
    ...createPolishQualityTests({ evaluate, js }),
    ...createCompleteQualityTests({ evaluate, js }),
    {
      name: "quality: duplicate titles reserve localized suffix space at character and emoji boundaries",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const rows = [];
            for (const locale of ["ja", "en"]) {
              const draft = createInitialState();
              draft.uiLanguage = locale;
              draft.pages[draft.currentPageId].blocks = [
                blk("text", "keep body"),
              ];
              window.__LeafNoteTest.setState(draft);
              const suffix = t("pageMenu.duplicateSuffix");
              const room = TEXT_FIELD_MAX_CHARS - suffix.length;
              const cases = [
                ["", t("common.untitled"), false],
                ["Short", "Short", false],
                ["題".repeat(room - 1), "題".repeat(room - 1), false],
                ["題".repeat(room), "題".repeat(room), false],
                ["題".repeat(room + 1), "題".repeat(room), true],
                ["題".repeat(TEXT_FIELD_MAX_CHARS), "題".repeat(room), true],
                ["a".repeat(room - 1) + "😀z", "a".repeat(room - 1), true],
                [
                  "a".repeat(room - 2) + "😀z",
                  "a".repeat(room - 2) + "😀",
                  true,
                ],
              ];
              for (const [title, expectedBase, truncated] of cases) {
                const source = getCurrentPage();
                source.title = title;
                const before = JSON.stringify(source.blocks);
                document.querySelector("#save-status").hidden = true;
                const copy = duplicatePage(source.id);
                clearTimeout(_saveTimer);
                _saveTimer = null;
                const normalized = normalizeStateShape(state);
                rows.push({
                  locale,
                  expected: expectedBase + suffix,
                  actual: copy.title,
                  withinLimit: copy.title.length <= TEXT_FIELD_MAX_CHARS,
                  wellFormed: copy.title.isWellFormed(),
                  sourceIntact:
                    source.title === title &&
                    JSON.stringify(source.blocks) === before,
                  warned:
                    !document.querySelector("#save-status").hidden &&
                    document.querySelector("#save-status").textContent ===
                      t("saveStatus.contentTrimmed"),
                  expectedWarning: truncated,
                  lossy: normalized.lossyRepair,
                  roundTrip:
                    normalized.state.pages[copy.id].title === copy.title,
                });
              }
            }
            return rows;
          }),
        );
        assert.equal(rows.length, 16);
        for (const row of rows) {
          assert.equal(row.actual, row.expected, row.locale);
          assert.equal(row.withinLimit, true);
          assert.equal(row.wellFormed, true);
          assert.equal(row.sourceIntact, true);
          assert.equal(row.warned, row.expectedWarning);
          assert.equal(row.lossy, false);
          assert.equal(row.roundTrip, true);
        }
      },
    },
    {
      name: "quality: duplicate titles and child content survive storage and actual reload without lossy repair",
      run: async (page) => {
        for (const locale of ["ja", "en"]) {
          const expected = await evaluate(
            page,
            `(${(async (locale) => {
              const draft = createInitialState();
              draft.uiLanguage = locale;
              const originalId = draft.currentPageId;
              draft.pages[originalId].title = "題".repeat(TEXT_FIELD_MAX_CHARS);
              draft.pages[originalId].blocks = [blk("text", "parent body")];
              window.__LeafNoteTest.setState(draft);
              const child = createPage(originalId, { title: "Child" });
              child.blocks = [blk("text", "child body")];
              const copy = duplicatePage(originalId);
              state.currentPageId = copy.id;
              clearTimeout(_saveTimer);
              _saveTimer = null;
              const saved = await _doSave({ force: true });
              const stored = await loadStateAsync();
              return {
                saved,
                originalId,
                copyId: copy.id,
                childId: copy.children[0],
                expectedTitle:
                  "題".repeat(
                    TEXT_FIELD_MAX_CHARS - t("pageMenu.duplicateSuffix").length,
                  ) + t("pageMenu.duplicateSuffix"),
                storedTitle: stored.pages[copy.id].title,
              };
            }).toString()})(${JSON.stringify(locale)})`,
          );
          assert.equal(expected.saved, true);
          assert.equal(expected.storedTitle, expected.expectedTitle);
          const loaded = page.waitForEvent("Page.loadEventFired");
          await page.send("Page.reload");
          await loaded;
          const actual = await evaluate(
            page,
            js(async () => {
              await window.__LeafNoteTest.ready;
              const copy = getCurrentPage();
              return {
                copyId: copy.id,
                title: copy.title,
                parentBody: copy.blocks[0].content,
                childId: copy.children[0],
                childTitle: state.pages[copy.children[0]].title,
                childBody: state.pages[copy.children[0]].blocks[0].content,
                lossy: !!_startupLossyRepairSnapshot,
                normalizedLossy: normalizeStateShape(state).lossyRepair,
                originalTitles: Object.values(state.pages).filter(
                  (p) => p.title === "題".repeat(TEXT_FIELD_MAX_CHARS),
                ).length,
              };
            }),
          );
          assert.deepEqual(actual, {
            copyId: expected.copyId,
            title: expected.expectedTitle,
            parentBody: "parent body",
            childId: expected.childId,
            childTitle: "Child",
            childBody: "child body",
            lossy: false,
            normalizedLossy: false,
            originalTitles: 1,
          });
        }
      },
    },
    ...createSilentQualityTests({ evaluate, js }),
    ...createTenRoundTests({ evaluate, js }),
    ...createInteractionTests({ evaluate, js }),
    ...createEditingTests({ evaluate, js }),
    {
      name: "quality: HTML export filename and embedded document name use the same snapshot",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            api.renderAll();
            const originalDialog = showSaveDocumentDialog,
              originalSource = getSourceHtmlForExport,
              originalDownload = _downloadBlob;
            let download;
            try {
              showSaveDocumentDialog = async () => "Snapshot name";
              getSourceHtmlForExport = async () => {
                const name = document.querySelector("#document-name");
                name.textContent = "Later live name";
                name.dispatchEvent(new Event("input", { bubbles: true }));
                return document.documentElement.outerHTML;
              };
              _downloadBlob = (blob, name) => {
                download = { blob, name };
              };
              document.querySelector("#export-btn").click();
              for (let i = 0; i < 30 && !download; i++)
                await new Promise((r) => setTimeout(r, 10));
              if (!download) throw new Error("Export did not complete");
              const html = await download.blob.text();
              const documentCopy = new DOMParser().parseFromString(
                html,
                "text/html",
              );
              const exported = JSON.parse(
                documentCopy.querySelector("#embedded-state").textContent,
              );
              return {
                fileName: download.name,
                exported: exported.workspaceName,
                live: api.getState().workspaceName,
              };
            } finally {
              showSaveDocumentDialog = originalDialog;
              getSourceHtmlForExport = originalSource;
              _downloadBlob = originalDownload;
            }
          }),
        );
        assert.match(
          result.fileName,
          /^Snapshot_name-\d{4}-\d{2}-\d{2}\.html$/,
        );
        assert.equal(result.exported, "Snapshot name");
        assert.equal(result.live, "Later live name");
      },
    },
    {
      name: "quality: merged rich text places the caret at the original join after entities and line breaks",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            const first = blk("text", "A&amp;B<br>C");
            const second = blk("text", "D");
            draft.pages[draft.currentPageId].blocks = [first, second];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelector(
              blockEditableSelectorById(second.id),
            );
            target.focus();
            placeCaret(target, "start");
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Backspace",
                bubbles: true,
                cancelable: true,
              }),
            );
            await new Promise((r) => setTimeout(r, 20));
            return {
              content: first.content,
              offset: getCaretTextOffset(
                document.querySelector(blockEditableSelectorById(first.id)),
              ),
            };
          }),
        );
        assert.equal(result.content, "A&amp;B<br>CD");
        assert.equal(result.offset, 4);
      },
    },
    {
      name: "quality: malformed JSON field types cannot throw during document restoration",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const fields = [
              "lastModifiedAt",
              "exportedAt",
              "trashAutoPurgeDays",
              "trashLastAutoPurge.count",
              "trashLastAutoPurge.at",
              "pages.p.createdAt",
              "pages.p.updatedAt",
              "pages.p.deletedAt",
              "pages.p.blocks.0.rows",
              "pages.p.blocks.0.cols",
              "pages.p.blocks.0.fileSize",
              "pages.p.blocks.1.governanceOwner",
              "pages.p.blocks.2.summary",
              "pages.p.blocks.3.definitions.0.term",
            ];
            const values = [
              null,
              false,
              [],
              {},
              { valueOf: 1, toString: 2 },
              [{ toString: null }],
              "NaN",
              "Infinity",
            ];
            const failures = [];
            for (const field of fields)
              for (const value of values) {
                const raw = {
                  pages: {
                    p: {
                      id: "p",
                      title: "kept",
                      blocks: [
                        {
                          id: "a",
                          type: "table",
                          rows: 1,
                          cols: 1,
                          cells: [["keep"]],
                        },
                        { id: "b", type: "decision", content: "decision body" },
                        { id: "c", type: "api_spec", summary: "summary" },
                        {
                          id: "d",
                          type: "definition_list",
                          definitions: [
                            { term: "term", definition: "definition" },
                          ],
                        },
                      ],
                    },
                  },
                  rootPages: ["p"],
                  currentPageId: "p",
                  trashLastAutoPurge: { count: 1, days: 7, at: 1 },
                };
                const keys = field.split(".");
                let target = raw;
                for (const key of keys.slice(0, -1)) target = target[key];
                target[keys.at(-1)] = value;
                try {
                  const result = normalizeStateShape(
                    JSON.parse(JSON.stringify(raw)),
                  );
                  sanitizeStateInPlace(result.state);
                  if (
                    !result.state.pages.p ||
                    result.state.pages.p.title !== "kept"
                  )
                    throw new Error("page lost");
                } catch (error) {
                  failures.push({ field, value, error: error.message });
                }
              }
            return { count: fields.length * values.length, failures };
          }),
        );
        assert.equal(result.count, 112);
        assert.deepEqual(result.failures, []);
      },
    },
    {
      name: "quality: seeded page lifecycle sequences preserve every live and trashed subtree across normalization",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            let operations = 0;
            for (let seed = 1; seed <= 16; seed++) {
              let random = seed;
              const pick = (values) => {
                random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
                return values[random % values.length];
              };
              const draft = api.createInitialState();
              const anchor = draft.currentPageId;
              draft.pages[anchor].blocks = [blk("text", "anchor")];
              api.setState(draft);
              const model = new Map([
                [anchor, { parent: null, deleted: false, body: "anchor" }],
              ]);
              const subtree = (id) => {
                const out = [id];
                for (let i = 0; i < out.length; i++)
                  for (const [key, value] of model)
                    if (value.parent === out[i]) out.push(key);
                return out;
              };
              for (let step = 0; step < 128; step++) {
                const live = [...model.keys()].filter(
                  (id) => !model.get(id).deleted,
                );
                const trash = [...model.keys()].filter(
                  (id) => model.get(id).deleted && !model.get(id).parent,
                );
                const action = pick([
                  "create",
                  "create",
                  "delete",
                  "restore",
                  "purge",
                ]);
                if (action === "create" && model.size < 40) {
                  const parent = pick([null, ...live]);
                  const p = createPage(parent);
                  p.blocks = [blk("text", `seed${seed}-step${step}`)];
                  model.set(p.id, {
                    parent,
                    deleted: false,
                    body: p.blocks[0].content,
                  });
                } else if (action === "delete" && live.length > 1) {
                  const id = pick(live.filter((id) => id !== anchor));
                  const entry = model.get(id);
                  entry.previous = entry.parent;
                  subtree(id).forEach((key) => {
                    model.get(key).deleted = true;
                  });
                  entry.parent = null;
                  deletePage(id);
                } else if (action === "restore" && trash.length) {
                  const id = pick(trash);
                  const entry = model.get(id);
                  subtree(id).forEach((key) => {
                    model.get(key).deleted = false;
                  });
                  entry.parent =
                    entry.previous &&
                    model.has(entry.previous) &&
                    !model.get(entry.previous).deleted
                      ? entry.previous
                      : null;
                  delete entry.previous;
                  restorePage(id);
                } else if (action === "purge" && trash.length) {
                  const id = pick(trash);
                  subtree(id).forEach((key) => model.delete(key));
                  purgePage(id);
                }
                if (step % 7 === 0)
                  api.setState(JSON.parse(JSON.stringify(api.getState())));
                const actual = api.getState();
                const fail = (message) => {
                  throw new Error(
                    `seed=${seed}, step=${step}, action=${action}: ${message}`,
                  );
                };
                if (Object.keys(actual.pages).length !== model.size)
                  fail("page count changed");
                for (const [id, expected] of model) {
                  const p = actual.pages[id];
                  if (
                    !p ||
                    p.parentId !== expected.parent ||
                    !!p.deletedAt !== expected.deleted ||
                    p.blocks[0].content !== expected.body
                  )
                    fail(`page content or relationship changed: ${id}`);
                }
                const roots = [...model.keys()]
                  .filter(
                    (id) => !model.get(id).parent && !model.get(id).deleted,
                  )
                  .sort();
                if (
                  JSON.stringify(actual.rootPages.slice().sort()) !==
                  JSON.stringify(roots)
                )
                  fail("root list changed");
                if (
                  !actual.pages[actual.currentPageId] ||
                  actual.pages[actual.currentPageId].deletedAt
                )
                  fail("current page is not live");
                operations++;
              }
            }
            return { operations };
          }),
        );
        assert.equal(result.operations, 2048);
      },
    },
    {
      name: "quality: percent-encoded attachment bytes match browser decoding at the exact size limit",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(async () => {
            const urls = [
              "data:application/octet-stream,%00%FF%80%41",
              "data:text/plain,あ😀%20A",
              "data:text/plain,100%25%20done",
            ];
            return Promise.all(
              urls.map(async (url) => {
                const native = new Uint8Array(
                  await (await fetch(url)).arrayBuffer(),
                );
                const actual = new Uint8Array(
                  await _dataUrlToBlob(url, {
                    maxBytes: native.length,
                  }).arrayBuffer(),
                );
                return {
                  expected: [...native],
                  actual: [...actual],
                  estimated: _estimateDataUrlDecodedBytes(url),
                };
              }),
            );
          }),
        );
        for (const row of rows) {
          assert.deepEqual(row.actual, row.expected);
          assert.equal(row.estimated, row.expected.length);
        }
      },
    },
    {
      name: "quality: download failures release object URLs and temporary anchors for every export path",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            api.renderAll();
            const originalClick = HTMLAnchorElement.prototype.click,
              originalCreate = URL.createObjectURL,
              originalRevoke = URL.revokeObjectURL,
              originalAlert = showAlert,
              originalDialog = showSaveDocumentDialog,
              originalSource = getSourceHtmlForExport;
            const created = [],
              revoked = [];
            const initialAnchors = document.querySelectorAll("a").length;
            try {
              URL.createObjectURL = () => {
                const url = `blob:quality-${created.length}`;
                created.push(url);
                return url;
              };
              URL.revokeObjectURL = (url) => revoked.push(url);
              HTMLAnchorElement.prototype.click = () => {
                throw new Error("download blocked");
              };
              showAlert = async () => true;
              showSaveDocumentDialog = async () => "test";
              getSourceHtmlForExport = async () =>
                document.documentElement.outerHTML;
              await downloadFileBlock(
                blk("file", "", {
                  fileDataUrl: "data:text/plain;base64,QQ==",
                  fileName: "test.txt",
                }),
              );
              try {
                exportPageAsMarkdown(api.getState().currentPageId);
              } catch {}
              document.querySelector("#export-btn").click();
              await new Promise((r) => setTimeout(r, 30));
              return {
                created,
                revoked,
                anchorsBefore: initialAnchors,
                anchorsAfter: document.querySelectorAll("a").length,
              };
            } finally {
              HTMLAnchorElement.prototype.click = originalClick;
              URL.createObjectURL = originalCreate;
              URL.revokeObjectURL = originalRevoke;
              showAlert = originalAlert;
              showSaveDocumentDialog = originalDialog;
              getSourceHtmlForExport = originalSource;
            }
          }),
        );
        assert.equal(result.created.length, 3);
        assert.deepEqual(result.revoked, result.created);
        assert.equal(result.anchorsAfter, result.anchorsBefore);
      },
    },
    {
      name: "quality: legacy footnotes preserve literal angle brackets while migrating to text blocks",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const draft = createInitialState();
            draft.pages[draft.currentPageId].blocks = [
              {
                id: "legacy",
                type: "footnote",
                label: "x",
                content: "Use <widget> & <script>literal</script>",
              },
            ];
            const normalized = normalizeStateShape(draft);
            sanitizeStateInPlace(normalized.state);
            return stripHTMLToText(
              normalized.state.pages[draft.currentPageId].blocks[0].content,
            );
          }),
        );
        assert.equal(result, "[^x]: Use <widget> & <script>literal</script>");
      },
    },
    {
      name: "quality: repeated autosaves share an outstanding save and reach fallback",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            draft.workspaceName = "slow database fallback";
            api.setState(draft);
            const originalOpen = openDB;
            let opens = 0;
            try {
              openDB = async () => {
                opens++;
                await new Promise((r) => setTimeout(r, 150));
                throw new Error("stalled database");
              };
              const saves = [];
              for (let i = 0; i < 8; i++) {
                saves.push(_doSave({ force: true }));
                await new Promise((r) => setTimeout(r, 10));
              }
              return {
                saved: await Promise.all(saves),
                opens,
                name: JSON.parse(localStorage.getItem(STATE_STORAGE_KEY))
                  .workspaceName,
              };
            } finally {
              openDB = originalOpen;
            }
          }),
        );
        assert.deepEqual(result.saved, Array(8).fill(true));
        assert.equal(result.opens, 1);
        assert.equal(result.name, "slow database fallback");
      },
    },
    {
      name: "quality: lock rejection and lock timeout preserve stored data without unhandled errors",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            api.setState(api.createInitialState());
            await _doSave({ force: true });
            const before = localStorage.getItem(STATE_STORAGE_KEY);
            const originalRequest = navigator.locks.request,
              originalTimeout = window.setTimeout;
            let rejectedResult, release;
            try {
              api.getState().workspaceName = "unsaved lock failure";
              navigator.locks.request = async () => {
                throw new DOMException("denied", "SecurityError");
              };
              rejectedResult = await _doSave();
            } finally {
              navigator.locks.request = originalRequest;
            }
            const held = navigator.locks.request(
              STATE_STORAGE_KEY,
              () =>
                new Promise((r) => {
                  release = r;
                }),
            );
            while (!release) await new Promise((r) => setTimeout(r, 1));
            let timeoutResult;
            try {
              window.setTimeout = (fn, ms, ...args) =>
                originalTimeout(
                  fn,
                  ms === STORAGE_LOCK_TIMEOUT_MS ? 20 : ms,
                  ...args,
                );
              timeoutResult = await _doSave();
            } finally {
              window.setTimeout = originalTimeout;
              release();
              await held;
            }
            const unchanged =
              before === localStorage.getItem(STATE_STORAGE_KEY);
            const dirty = _hasUnsavedState();
            const recovered = await _doSave();
            return {
              rejectedResult,
              timeoutResult,
              unchanged,
              dirty,
              recovered,
            };
          }),
        );
        assert.deepEqual(result, {
          rejectedResult: false,
          timeoutResult: false,
          unchanged: true,
          dirty: true,
          recovered: true,
        });
      },
    },
    {
      name: "quality: stalled read and write transactions release connections and reach local storage",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            // Earlier cases deliberately replace stored snapshots. Establish the
            // current baseline just as startup does before testing transaction timeouts.
            await loadStateAsync({ trackStorageBaseline: true });
            api.setState(api.createInitialState());
            if (!(await _doSave({ force: true })))
              throw new Error(
                "Could not establish the transaction timeout fixture",
              );
            const originalOpen = openDB,
              originalTimeout = window.setTimeout;
            let closed = 0,
              aborted = 0;
            try {
              window.setTimeout = (fn, ms, ...args) =>
                originalTimeout(
                  fn,
                  ms === DB_TRANSACTION_TIMEOUT_MS ? 20 : ms,
                  ...args,
                );
              openDB = async () => ({
                close() {
                  closed++;
                },
                transaction() {
                  return {
                    abort() {
                      aborted++;
                    },
                    objectStore() {
                      return {
                        get() {
                          return {};
                        },
                      };
                    },
                  };
                },
              });
              const loaded = await loadStateAsync();
              api.getState().workspaceName = "transaction fallback";
              const saved = await _doSave();
              return {
                loaded: !!loaded?.pages,
                saved,
                closed,
                aborted,
                name: JSON.parse(localStorage.getItem(STATE_STORAGE_KEY))
                  .workspaceName,
              };
            } finally {
              openDB = originalOpen;
              window.setTimeout = originalTimeout;
            }
          }),
        );
        assert.deepEqual(result, {
          loaded: true,
          saved: true,
          closed: 2,
          aborted: 2,
          name: "transaction fallback",
        });
      },
    },
    {
      name: "quality: independently trashed subtrees survive reload and parent purge",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            return [false, true].map((legacy) => {
              const draft = api.createInitialState();
              const parent = draft.pages[draft.currentPageId];
              const child = api.createPage(parent.id, {
                title: "separate trash",
              });
              const grandchild = api.createPage(child.id, {
                title: "nested content",
              });
              api.setState(draft);
              deletePage(child.id);
              if (legacy) api.getState().pages[child.id].parentId = parent.id;
              api.setState(JSON.parse(JSON.stringify(api.getState())));
              const reattached = api
                .getState()
                .pages[parent.id].children.includes(child.id);
              deletePage(parent.id);
              const trashRoots = listTrashRoots().map((p) => p.id);
              purgePage(parent.id);
              const retained =
                !!api.getState().pages[child.id] &&
                !!api.getState().pages[grandchild.id];
              restorePage(child.id);
              return {
                legacy,
                reattached,
                separateRoots:
                  trashRoots.includes(child.id) &&
                  trashRoots.includes(parent.id),
                retained,
                restored:
                  !!api.getState().pages[child.id] &&
                  !api.getState().pages[child.id].deletedAt,
                childParent: api.getState().pages[grandchild.id]?.parentId,
                expectedParent: child.id,
              };
            });
          }),
        );
        for (const row of rows) {
          assert.equal(row.reattached, false, JSON.stringify(row));
          assert.equal(row.separateRoots, true);
          assert.equal(row.retained, true);
          assert.equal(row.restored, true);
          assert.equal(row.childParent, row.expectedParent);
        }
      },
    },
    {
      name: "quality: page identifiers cannot collide with inherited object properties",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() =>
            ["__proto__", "constructor", "toString"].map((id) => {
              const raw = {
                pages: Object.fromEntries([
                  [
                    id,
                    {
                      id,
                      title: "retained",
                      blocks: [{ id: "b", type: "text", content: "body" }],
                      children: [],
                    },
                  ],
                ]),
                rootPages: [id],
                currentPageId: id,
              };
              const normalized = normalizeStateShape(
                JSON.parse(JSON.stringify(raw)),
              );
              const second = normalizeStateShape(
                JSON.parse(JSON.stringify(normalized.state)),
              );
              return {
                id,
                ids: Object.keys(second.state.pages),
                title: second.state.pages[id]?.title,
                current: second.state.currentPageId,
                polluted: Object.prototype.title != null,
              };
            }),
          ),
        );
        for (const row of rows) {
          assert.deepEqual(row.ids, [row.id]);
          assert.equal(row.title, "retained");
          assert.equal(row.current, row.id);
          assert.equal(row.polluted, false);
        }
      },
    },
    {
      name: "quality: every structural truncation marks startup repair as lossy",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const cases = [];
            const deep = {
              id: "d0",
              type: "toggle",
              content: "root",
              children: [],
            };
            let tail = deep;
            for (let i = 1; i <= BLOCK_MAX_DEPTH + 1; i++) {
              const child = {
                id: `d${i}`,
                type: "toggle",
                content: `level${i}`,
                children: [],
              };
              tail.children.push(child);
              tail = child;
            }
            cases.push(deep);
            cases.push({
              id: "table",
              type: "table",
              rows: 1,
              cols: 1,
              cells: [["kept", "otherwise lost"]],
            });
            cases.push({
              id: "spec",
              type: "db_table",
              columns: Array.from(
                { length: SPEC_COLUMNS_MAX_ROWS + 1 },
                (_, i) => ({ name: `column${i}` }),
              ),
            });
            return cases.map((block) => {
              const draft = createInitialState();
              draft.pages[draft.currentPageId].blocks = [block];
              const raw = JSON.stringify(draft);
              const result = normalizeStateShape(draft);
              return {
                type: block.type,
                lossy: result.lossyRepair,
                originalIntact: raw === JSON.stringify(draft),
              };
            });
          }),
        );
        for (const row of rows) {
          assert.equal(row.lossy, true, row.type);
          assert.equal(row.originalIntact, true, row.type);
        }
      },
    },
    {
      name: "quality: malformed embedded state never displaces a usable browser document",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const good = createInitialState();
            good.workspaceName = "browser document";
            return [
              { pages: [] },
              { pages: {} },
              { pages: { broken: null } },
              { pages: { broken: [] } },
            ].map(
              (embedded) =>
                chooseStartupState(embedded, good, createInitialState())
                  .workspaceName,
            );
          }),
        );
        assert.deepEqual(result, Array(4).fill("browser document"));
      },
    },
    {
      name: "quality: Backspace refuses hidden-field and raw-source merges",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            return [
              "toc",
              "api_spec",
              "db_table",
              "screen_spec",
              "test_case",
              "html",
              "math",
              "mermaid",
              "code",
              "image",
              "file",
              "table",
              "toggle",
              "text",
            ].map((type) => {
              const draft = api.createInitialState();
              const before = blk(type, "original");
              const after = blk("text", "<b>retain me</b>");
              draft.pages[draft.currentPageId].blocks = [before, after];
              api.setState(draft);
              api.renderAll();
              const blocks =
                api.getState().pages[api.getState().currentPageId].blocks;
              const snapshot = JSON.stringify(blocks);
              const target = document.querySelector(
                blockEditableSelectorById(after.id),
              );
              target.focus();
              placeCaret(target, "start");
              target.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "Backspace",
                  bubbles: true,
                  cancelable: true,
                }),
              );
              return {
                type,
                unchanged: snapshot === JSON.stringify(blocks),
                merged:
                  blocks.length === 1 &&
                  blocks[0].content === "original<b>retain me</b>",
              };
            });
          }),
        );
        for (const row of rows) {
          if (row.type === "text") assert.equal(row.merged, true);
          else assert.equal(row.unchanged, true, row.type);
        }
      },
    },
    {
      name: "quality: merging two valid text blocks cannot discard text at the field limit",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            const first = blk("text", "a".repeat(RICH_HTML_FIELD_MAX_BYTES));
            const second = blk("text", "tail must survive");
            draft.pages[draft.currentPageId].blocks = [first, second];
            api.setState(draft);
            api.renderAll();
            const before = JSON.stringify(
              api.getState().pages[draft.currentPageId].blocks,
            );
            const target = document.querySelector(
              blockEditableSelectorById(second.id),
            );
            target.focus();
            placeCaret(target, "start");
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Backspace",
                bubbles: true,
                cancelable: true,
              }),
            );
            return (
              before ===
              JSON.stringify(api.getState().pages[draft.currentPageId].blocks)
            );
          }),
        );
        assert.equal(result, true);
      },
    },
    {
      name: "quality: Enter replaces the selected text and preserves the split suffix",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            const block = blk("text", "beforeSELECTEDafter");
            draft.pages[draft.currentPageId].blocks = [block];
            api.setState(draft);
            api.renderAll();
            const target = document.querySelector(
              blockEditableSelectorById(block.id),
            );
            target.focus();
            const range = document.createRange();
            range.setStart(target.firstChild, 6);
            range.setEnd(target.firstChild, 14);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
                cancelable: true,
              }),
            );
            return api
              .getState()
              .pages[draft.currentPageId].blocks.map((b) => b.content);
          }),
        );
        assert.deepEqual(result, ["before", "after"]);
      },
    },
    {
      name: "quality: rich text converts to raw source and back without exposing HTML markup",
      run: async (page) => {
        const rows = await evaluate(
          page,
          js(() =>
            ["code", "html", "math", "mermaid"].map((type) => {
              const api = window.__LeafNoteTest;
              const draft = api.createInitialState();
              const block = blk(
                "text",
                "<b>&lt;tag&gt;</b><br>second &amp; line",
              );
              draft.pages[draft.currentPageId].blocks = [block];
              api.setState(draft);
              api.renderAll();
              convertBlockType(block, type);
              const raw = block.content;
              convertBlockType(block, "text");
              return { type, raw, restored: stripHTMLToText(block.content) };
            }),
          ),
        );
        for (const row of rows) {
          assert.equal(row.raw, "<tag>\nsecond & line", row.type);
          assert.equal(row.restored, row.raw, row.type);
        }
      },
    },
    {
      name: "quality: raw-source conversion refuses expansion beyond the rich-text byte limit",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            const block = blk(
              "code",
              "&".repeat(Math.floor(RICH_HTML_FIELD_MAX_BYTES / 5) + 1),
            );
            draft.pages[draft.currentPageId].blocks = [block];
            api.setState(draft);
            const before = JSON.stringify(block);
            convertBlockType(block, "text");
            return before === JSON.stringify(block);
          }),
        );
        assert.equal(result, true);
      },
    },
    {
      name: "quality: undo records each edit burst even when storage remains unavailable",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(async () => {
            const api = window.__LeafNoteTest;
            const draft = api.createInitialState();
            draft.pages[draft.currentPageId].blocks = [blk("text", "A")];
            api.setState(draft);
            const originalOpen = openDB,
              originalSet = Storage.prototype.setItem;
            const body = () =>
              api.getState().pages[api.getState().currentPageId].blocks[0]
                .content;
            try {
              openDB = async () => {
                throw new Error("database unavailable");
              };
              Storage.prototype.setItem = function (key, value) {
                if (key === STATE_STORAGE_KEY)
                  throw new DOMException("full", "QuotaExceededError");
                return originalSet.call(this, key, value);
              };
              const saves = [];
              for (const text of ["B", "C"]) {
                api.getState().pages[
                  api.getState().currentPageId
                ].blocks[0].content = text;
                saveState();
                saves.push(await _doSave());
                _flushPendingUndoSnapshot();
              }
              undo();
              const first = body();
              undo();
              const second = body();
              redo();
              const third = body();
              redo();
              const fourth = body();
              await new Promise((resolve) => setTimeout(resolve, 50));
              return { saves, values: [first, second, third, fourth] };
            } finally {
              openDB = originalOpen;
              Storage.prototype.setItem = originalSet;
            }
          }),
        );
        assert.deepEqual(result.saves, [false, false]);
        assert.deepEqual(result.values, ["B", "A", "B", "C"]);
      },
    },
  ];
}
