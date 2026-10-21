import assert from "node:assert/strict";

function setupRestoreFixture(targetDepth = 30, withGrandchild = true) {
  const api = window.__LeafNoteTest;
  api.setState(api.createInitialState());
  for (const overlay of document.querySelectorAll(".overlay"))
    if (!overlay.hidden) dismissOverlay(overlay);
  const parent = createPage(null, { title: "Former parent" });
  const child = createPage(parent.id, { title: "Restored note" });
  child.blocks = [blk("text", "parent content")];
  const grand = withGrandchild
    ? createPage(child.id, { title: "Descendant" })
    : null;
  if (grand) grand.blocks = [blk("text", "descendant content")];
  deletePage(child.id);
  let destination = createPage(null);
  for (let depth = 1; depth <= targetDepth; depth++)
    destination = createPage(destination.id);
  movePage(parent.id, destination.id);
  clearTimeout(_saveTimer);
  _saveTimer = null;
  api.setState(JSON.parse(JSON.stringify(state)));
  api.renderAll();
  window.restoreFixture = {
    parent: parent.id,
    child: child.id,
    grand: grand?.id,
  };
  return window.restoreFixture;
}

export function createPageRestoreTests({ evaluate, js }) {
  const setup = (page, depth = 30, withGrandchild = true) =>
    evaluate(
      page,
      `(${setupRestoreFixture.toString()})(${depth}, ${withGrandchild})`,
    );
  return [
    {
      name: "restore: subtree depth boundaries reject mutations before changing trash or history",
      run: async (page) => {
        for (const [depth, withGrandchild, allowed] of [
          [28, true, true],
          [29, true, true],
          [30, true, false],
          [30, false, true],
          [31, false, false],
        ]) {
          await setup(page, depth, withGrandchild);
          const result = await evaluate(
            page,
            js(() => {
              const { child } = window.restoreFixture;
              const before = JSON.stringify(state);
              const history = JSON.stringify(_historyStackInfo());
              restorePage(child);
              return {
                restored: !state.pages[child].deletedAt,
                unchanged: before === JSON.stringify(state),
                historyUnchanged:
                  history === JSON.stringify(_historyStackInfo()),
                noPendingEdit: _pendingSnapshot === null,
                maxDepth: Math.max(
                  ..._collectPageSubtreeIds(child).map((id) =>
                    _getPageDepth(id),
                  ),
                ),
              };
            }),
          );
          assert.equal(result.restored, allowed, `${depth}/${withGrandchild}`);
          if (allowed) assert.ok(result.maxDepth <= 32);
          else {
            assert.equal(result.unchanged, true);
            assert.equal(result.historyUnchanged, true);
            assert.equal(result.noPendingEdit, true);
          }
        }
      },
    },
    {
      name: "restore: root confirmation cancels safely and retains descendants through undo copy and reload",
      run: async (page) => {
        for (const locale of ["ja", "en"]) {
          const ids = await setup(page);
          const result = await evaluate(
            page,
            `(${(async (locale) => {
              setUiLanguage(locale);
              _flushPendingUndoSnapshot();
              clearTimeout(_saveTimer);
              _saveTimer = null;
              await _doSave({ force: true });
              const { child, grand } = window.restoreFixture;
              const before = JSON.stringify(state);
              const storedBefore = JSON.stringify(await loadStateAsync());
              const history = JSON.stringify(_historyStackInfo());
              openTrashModal();
              const button = document.querySelector(
                ".trash-item .trash-action-btn",
              );
              const cancelled = button.onclick();
              if (document.querySelector("#dialog-overlay").hidden)
                return { confirmationShown: false };
              const message =
                document.querySelector("#dialog-message").textContent;
              const beforeDecision = before === JSON.stringify(state);
              document.querySelector("#dialog-box [data-cancel]").click();
              await cancelled;
              const unchanged = before === JSON.stringify(state);
              const historyUnchanged =
                history === JSON.stringify(_historyStackInfo());
              const storedUnchanged =
                storedBefore === JSON.stringify(await loadStateAsync());
              const accepted = button.onclick();
              document.querySelector("#dialog-box [data-ok]").click();
              await accepted;
              closeTrashModal();
              const rootRestored =
                state.pages[child].parentId === null &&
                !state.pages[child].deletedAt;
              Object.keys(state.pages).forEach((id) => expandedPages.add(id));
              renderSidebar();
              const visible = [child, grand].every((id) =>
                document.querySelector(`[data-page-id="${id}"]`),
              );
              const undone =
                undo() &&
                !!state.pages[child].deletedAt &&
                !!state.pages[grand].deletedAt;
              const redone =
                redo() &&
                !state.pages[child].deletedAt &&
                state.pages[grand].parentId === child;
              const copy = duplicatePage(child);
              const copied = _collectPageSubtreeIds(copy.id).map(
                (id) => state.pages[id].blocks[0].content,
              );
              state.currentPageId = child;
              clearTimeout(_saveTimer);
              _saveTimer = null;
              const saved = await _doSave({ force: true });
              return {
                confirmationShown: true,
                message,
                beforeDecision,
                unchanged,
                historyUnchanged,
                storedUnchanged,
                rootRestored,
                visible,
                undone,
                redone,
                copied,
                saved,
              };
            }).toString()})(${JSON.stringify(locale)})`,
          );
          assert.equal(result.confirmationShown, true);
          assert.match(result.message, /Restored note/);
          assert.match(
            result.message,
            locale === "ja" ? /最上位/ : /top level/,
          );
          for (const key of [
            "beforeDecision",
            "unchanged",
            "historyUnchanged",
            "storedUnchanged",
            "rootRestored",
            "visible",
            "undone",
            "redone",
            "saved",
          ])
            assert.equal(result[key], true, key);
          assert.deepEqual(result.copied, [
            "parent content",
            "descendant content",
          ]);
          const loaded = page.waitForEvent("Page.loadEventFired");
          await page.send("Page.reload");
          await loaded;
          const restored = await evaluate(
            page,
            `(${(async ({ child, grand }) => {
              await window.__LeafNoteTest.ready;
              return {
                parent: state.pages[child].parentId,
                child: state.pages[grand].parentId,
                contents: [
                  state.pages[child].blocks[0].content,
                  state.pages[grand].blocks[0].content,
                ],
                lossy: !!_startupLossyRepairSnapshot,
              };
            }).toString()})(${JSON.stringify(ids)})`,
          );
          assert.deepEqual(restored, {
            parent: null,
            child: ids.child,
            contents: ["parent content", "descendant content"],
            lossy: false,
          });
        }
      },
    },
    {
      name: "restore: missing parents and invalid subtrees preserve safe restoration semantics",
      run: async (page) => {
        for (const removed of [false, true]) {
          await setup(page);
          const result = await evaluate(
            page,
            `(${((removed) => {
              const { parent, child, grand } = window.restoreFixture;
              deletePage(parent);
              if (removed) purgePage(parent);
              const restored = restorePage(child);
              return {
                restored,
                atRoot: state.pages[child].parentId === null,
                descendantKept:
                  state.pages[grand].parentId === child &&
                  !state.pages[grand].deletedAt,
              };
            }).toString()})(${removed})`,
          );
          assert.deepEqual(result, {
            restored: true,
            atRoot: true,
            descendantKept: true,
          });
        }
        await setup(page);
        const result = await evaluate(
          page,
          js(async () => {
            const { child, grand } = window.restoreFixture;
            // A legacy malformed tree must be rejected without partially restoring it.
            let tail = grand;
            for (let i = 0; i < PAGE_MAX_DEPTH; i++) {
              const id = uid();
              state.pages[id] = {
                ...state.pages[grand],
                id,
                parentId: tail,
                children: [],
              };
              state.pages[tail].children.push(id);
              tail = id;
            }
            const before = JSON.stringify(state);
            const history = JSON.stringify(_historyStackInfo());
            const pending = restorePageFromTrash(child);
            const notified =
              !document.querySelector("#dialog-overlay").hidden &&
              document.querySelector("#dialog-message").textContent ===
                t("trash.restoreInvalid");
            document.querySelector("#dialog-box [data-ok]").click();
            const invalidRestored = await pending;
            return {
              notified,
              invalidRestored,
              unchanged: before === JSON.stringify(state),
              historyUnchanged: history === JSON.stringify(_historyStackInfo()),
            };
          }),
        );
        assert.deepEqual(result, {
          notified: true,
          invalidRestored: false,
          unchanged: true,
          historyUnchanged: true,
        });
      },
    },
    {
      name: "restore: delayed confirmation revalidates state identity and subtree depth",
      run: async (page) => {
        for (const change of ["state", "purge", "depth"]) {
          await setup(page);
          const result = await evaluate(
            page,
            `(${(async (change) => {
              const { child, grand } = window.restoreFixture;
              const pending = restorePageFromTrash(child);
              if (change === "state")
                window.__LeafNoteTest.setState(
                  JSON.parse(JSON.stringify(state)),
                );
              else if (change === "purge") purgePage(child);
              else {
                let tail = grand;
                for (let i = 0; i < PAGE_MAX_DEPTH; i++) {
                  const id = uid();
                  state.pages[id] = {
                    ...state.pages[grand],
                    id,
                    parentId: tail,
                    children: [],
                  };
                  state.pages[tail].children.push(id);
                  tail = id;
                }
              }
              const before = JSON.stringify(state);
              document.querySelector("#dialog-box [data-ok]").click();
              if (change === "depth") {
                await new Promise((resolve) => setTimeout(resolve, 0));
                document.querySelector("#dialog-box [data-ok]")?.click();
              }
              const restored = await pending;
              return { restored, unchanged: before === JSON.stringify(state) };
            }).toString()})(${JSON.stringify(change)})`,
          );
          assert.deepEqual(result, { restored: false, unchanged: true });
        }
      },
    },
  ];
}
