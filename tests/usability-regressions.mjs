import assert from "node:assert/strict";

export function createUsabilityTests({ evaluate, js }) {
  const reset = async (page) =>
    evaluate(
      page,
      js(() => {
        const api = window.__LeafNoteTest,
          draft = api.createInitialState();
        const root = draft.currentPageId;
        draft.pages[root].title = "仕事";
        draft.pages[root].blocks = [blk("text", "original")];
        const child = api.createPage(root, { title: "会議記録" });
        const grand = api.createPage(child.id, { title: "議事詳細" });
        const other = api.createPage(null, { title: "個人" });
        api.setState(draft);
        api.renderAll();
        window.usabilityIds = {
          root,
          child: child.id,
          grand: grand.id,
          other: other.id,
        };
        for (const overlay of document.querySelectorAll(".overlay"))
          if (!overlay.hidden) dismissOverlay(overlay);
        hideContextMenu();
        return window.usabilityIds;
      }),
    );
  return [
    {
      name: "usability: concise welcome localizes old untouched notes while retaining edited notes",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const api = window.__LeafNoteTest,
              draft = api.createInitialState();
            const note = draft.pages[draft.currentPageId];
            const freshCount = note.blocks.length;
            note.blocks = LEGACY_WELCOME_BLUEPRINTS.ja.map((item) =>
              blk(
                item.type,
                item.content,
                item.type === "callout"
                  ? { emoji: "💡", emojiType: "emoji", hasIcon: true }
                  : {},
              ),
            );
            const edited = structuredClone(note);
            edited.id = uid();
            edited.blocks.at(-1).checked = true;
            draft.pages[edited.id] = edited;
            draft.rootPages.push(edited.id);
            api.setState(draft);
            api.renderAll();
            const before = JSON.stringify(edited);
            setUiLanguage("en");
            const english = { title: note.title, count: note.blocks.length };
            const preserved = before === JSON.stringify(edited);
            setUiLanguage("ja");
            return {
              freshCount,
              english,
              preserved,
              japanese: note.title,
              callout: note.blocks.at(-1).type,
              valid: _matchesInitialWelcomeBlocks(note, "ja"),
            };
          }),
        );
        assert.equal(result.freshCount, 6);
        assert.deepEqual(result.english, {
          title: "Welcome to LeafNote",
          count: 6,
        });
        assert.equal(result.preserved, true);
        assert.equal(result.japanese, "LeafNote へようこそ");
        assert.equal(result.callout, "callout");
        assert.equal(result.valid, true);
      },
    },
    {
      name: "usability: previous welcome copy still localizes and edited content is preserved",
      run: async (page) => {
        for (const locale of ["ja", "en"]) {
          const result = await evaluate(
            page,
            `(${((locale) => {
              const api = window.__LeafNoteTest,
                draft = api.createInitialState();
              const note = draft.pages[draft.currentPageId];
              draft.uiLanguage = locale;
              note.title = PREVIOUS_WELCOME_COPY[locale].title;
              note.blocks = INITIAL_WELCOME_BLOCKS.map((item) =>
                blk(
                  item.type,
                  PREVIOUS_WELCOME_COPY[locale][item.key],
                  item.extra,
                ),
              );
              const edited = structuredClone(note);
              edited.id = uid();
              edited.blocks[0].content += " My writing";
              draft.pages[edited.id] = edited;
              draft.rootPages.push(edited.id);
              const before = JSON.stringify(edited);
              api.setState(draft);
              api.renderAll();
              setUiLanguage(locale === "ja" ? "en" : "ja");
              return {
                localized: _matchesInitialWelcomeBlocks(note, state.uiLanguage),
                preserved: before === JSON.stringify(edited),
              };
            }).toString()})(${JSON.stringify(locale)})`,
          );
          assert.equal(result.localized, true);
          assert.equal(result.preserved, true);
        }
      },
    },
    {
      name: "usability: help disclosure works with keyboard and excludes collapsed actions from Tab order",
      run: async (page) => {
        await reset(page);
        const before = await evaluate(
          page,
          js(() => {
            document.querySelector("#shortcuts-body").replaceChildren();
            openShortcutsModal();
            const overlay = document.querySelector("#shortcuts-overlay");
            const quick = overlay.querySelector('[data-group="quick"]');
            const focusable = getFocusableElements(overlay);
            const summary = quick.querySelector("summary");
            summary.focus();
            return {
              openGroups: [...overlay.querySelectorAll("details[open]")].map(
                (g) => g.dataset.group,
              ),
              summaryFocusable: focusable.includes(summary),
              hiddenActionsExcluded: [
                ...quick.querySelectorAll("button"),
              ].every((b) => !focusable.includes(b)),
              title: document.querySelector("#shortcuts-title").textContent,
            };
          }),
        );
        assert.deepEqual(before.openGroups, ["general"]);
        assert.equal(before.summaryFocusable, true);
        assert.equal(before.hiddenActionsExcluded, true);
        assert.equal(before.title, "使い方");
        await evaluate(
          page,
          "new Promise(resolve => setTimeout(resolve, 200))",
        );
        await evaluate(
          page,
          js(() =>
            document.querySelector('[data-group="quick"] summary').focus(),
          ),
        );
        await page.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await page.send("Input.dispatchKeyEvent", {
          type: "char",
          key: "Enter",
          code: "Enter",
          text: "\r",
          unmodifiedText: "\r",
          windowsVirtualKeyCode: 13,
        });
        await page.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        const after = await evaluate(
          page,
          js(() => {
            const quick = document.querySelector('[data-group="quick"]');
            const visibleActions = [...quick.querySelectorAll("button")].every(
              (b) =>
                getFocusableElements(
                  document.querySelector("#shortcuts-overlay"),
                ).includes(b),
            );
            const opened = quick.open;
            setUiLanguage("en");
            const preserved = document.querySelector(
              '[data-group="quick"]',
            ).open;
            const backup = [
              ...document.querySelectorAll('[data-group="quick"] button'),
            ].find((b) => b.textContent.startsWith("HTML backup"));
            const backupLabel = backup.textContent;
            backup.click();
            return { opened, visibleActions, preserved, backupLabel };
          }),
        );
        assert.equal(after.opened, true);
        assert.equal(after.visibleActions, true);
        assert.equal(after.preserved, true);
        assert.match(after.backupLabel, /^HTML backup/);
        await evaluate(page, "new Promise(resolve => setTimeout(resolve, 50))");
        assert.equal(
          await evaluate(
            page,
            '!dialogOverlay.hidden && document.querySelector("#dialog-title").textContent === "HTML backup"',
          ),
          true,
        );
        await evaluate(page, "hideDialog(null)");
      },
    },
    {
      name: "usability: search uses distinct ancestor paths and retains a visible label on narrow screens",
      run: async (page) => {
        for (const width of [320, 1280]) {
          await page.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 568,
            deviceScaleFactor: 1,
            mobile: false,
          });
          for (const locale of ["ja", "en"]) {
            await reset(page);
            const result = await evaluate(
              page,
              `(${((locale) => {
                state.uiLanguage = locale;
                applyLanguage();
                openSearchModal();
                const items = [
                  ...document.querySelectorAll("#search-results .search-item"),
                ];
                const paths = Object.fromEntries(
                  items.map((item) => [
                    item.querySelector(".search-item-title").textContent,
                    item.querySelector(".search-item-path")?.textContent ||
                      null,
                  ]),
                );
                const label = document.querySelector("#search-field-label");
                const rect = label.getBoundingClientRect();
                const inputRect = document
                  .querySelector("#search-input")
                  .getBoundingClientRect();
                const headingName = document
                  .querySelector("#page-title")
                  .getAttribute("aria-label");
                renderSearchResults("nothing matches 123");
                const empty = document.querySelector(
                  "#search-results .search-empty",
                ).textContent;
                const createCount = document.querySelectorAll(
                  "#search-results .search-item",
                ).length;
                closeSearchModal();
                return {
                  paths,
                  label: label.textContent,
                  visibleLabel: rect.width > 20 && rect.height > 10,
                  noOverflow:
                    document.documentElement.scrollWidth <= innerWidth,
                  stackedOnPhone:
                    innerWidth > 560 || inputRect.top >= rect.bottom - 1,
                  createLabel: document.querySelector(
                    "#search-results .search-item-title",
                  )?.textContent,
                  empty,
                  createCount,
                  headingName,
                };
              }).toString()})(${JSON.stringify(locale)})`,
            );
            assert.equal(result.paths["仕事"], null);
            assert.equal(result.paths["個人"], null);
            assert.equal(result.paths["会議記録"], "仕事");
            assert.equal(result.paths["議事詳細"], "仕事 / 会議記録");
            assert.equal(result.visibleLabel, true);
            assert.equal(result.noOverflow, true);
            assert.equal(result.stackedOnPhone, true);
            assert.equal(
              result.label,
              locale === "ja" ? "ノート検索" : "Note search",
            );
            assert.match(
              result.empty,
              locale === "ja" ? /検索語を変える/ : /Try another word/,
            );
            assert.equal(result.createCount, 1);
            assert.equal(result.headingName, null);
            assert.match(
              result.createLabel,
              locale === "ja" ? /^新規作成：/ : /^Create note:/,
            );
          }
        }
        await page.send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
      },
    },
    {
      name: "usability: moving a subtree preserves contents, rejects cycles and can be undone/redone",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            const { root, child, grand, other } = window.usabilityIds;
            const before = JSON.stringify(state);
            const moved = movePage(child, other);
            const contents = state.pages[grand].title;
            const targetChildren = state.pages[other].children.slice();
            const oldChildren = state.pages[root].children.slice();
            const invalidBefore = JSON.stringify(state);
            const cycle = movePage(other, grand);
            const unchanged = JSON.stringify(state) === invalidBefore;
            undo();
            const undone = state.pages[child].parentId === root;
            redo();
            const redone = state.pages[child].parentId === other;
            return {
              moved,
              contents,
              targetChildren,
              oldChildren,
              cycle,
              unchanged,
              undone,
              redone,
              child,
            };
          }),
        );
        assert.equal(result.moved, true);
        assert.equal(result.contents, "議事詳細");
        assert.deepEqual(result.targetChildren, [result.child]);
        assert.deepEqual(result.oldChildren, []);
        assert.equal(result.cycle, false);
        assert.equal(result.unchanged, true);
        assert.equal(result.undone, true);
        assert.equal(result.redone, true);
      },
    },
    {
      name: "usability: page moves respect the depth limit and deleted destinations",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            const { root, child, other } = window.usabilityIds;
            let parent = other;
            for (let i = 0; i < PAGE_MAX_DEPTH; i++) {
              const note = createPage(parent);
              parent = note.id;
            }
            const before = JSON.stringify(state);
            const tooDeep = movePage(child, parent);
            const depthUnchanged = before === JSON.stringify(state);
            state.pages[other].deletedAt = Date.now();
            const deleted = movePage(child, other);
            return {
              tooDeep,
              depthUnchanged,
              deleted,
              parent: state.pages[child].parentId,
              root,
            };
          }),
        );
        assert.equal(result.tooDeep, false);
        assert.equal(result.depthUnchanged, true);
        assert.equal(result.deleted, false);
        assert.equal(result.parent, result.root);
      },
    },
    {
      name: "usability: move dialog excludes descendants and applies the chosen destination",
      run: async (page) => {
        const ids = await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            const { root, other } = window.usabilityIds;
            showMovePageDialog(root);
            const select = document.querySelector("#move-page-destination");
            const options = [...select.options].map((o) => o.value);
            const initiallyDisabled = document.querySelector(
              "#dialog-box [data-ok]",
            ).disabled;
            select.value = other;
            select.dispatchEvent(new Event("change"));
            document.querySelector("#dialog-box [data-ok]").click();
            return {
              options,
              initiallyDisabled,
              destination: state.pages[root].parentId,
              closed: dialogOverlay.hidden,
            };
          }),
        );
        assert.deepEqual(result.options.sort(), ["", ids.other].sort());
        assert.equal(result.initiallyDisabled, true);
        assert.equal(result.destination, ids.other);
        assert.equal(result.closed, true);
      },
    },
    {
      name: "usability: sibling reordering stays in its parent and persists the new order",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(async () => {
            const { root, other, child } = window.usabilityIds;
            const moved = reorderPage(other, -1),
              order = state.rootPages.slice();
            const boundary = reorderPage(other, -1),
              childBoundary = reorderPage(child, -1);
            const saved = await _doSave({ force: true });
            const loaded = await loadStateAsync();
            return {
              moved,
              order,
              boundary,
              childBoundary,
              saved,
              loadedOrder: loaded.rootPages,
              root,
              other,
            };
          }),
        );
        assert.equal(result.moved, true);
        assert.deepEqual(result.order, [result.other, result.root]);
        assert.equal(result.boundary, false);
        assert.equal(result.childBoundary, false);
        assert.equal(result.saved, true);
        assert.deepEqual(result.loadedOrder, result.order);
      },
    },
    {
      name: "usability: switching notes and rebuilding the editor retains the reading position",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            const { root, other } = window.usabilityIds;
            state.pages[root].blocks = Array.from({ length: 100 }, (_, i) =>
              blk("text", `Paragraph ${i}`),
            );
            renderEditor();
            document.querySelector("#editor-scroll").scrollTop = 1700;
            const before = document.querySelector("#editor-scroll").scrollTop;
            switchPage(other);
            switchPage(root);
            const returned = document.querySelector("#editor-scroll").scrollTop;
            renderEditor();
            const rebuilt = document.querySelector("#editor-scroll").scrollTop;
            return { before, returned, rebuilt };
          }),
        );
        assert.ok(result.before > 0);
        assert.equal(result.returned, result.before);
        assert.equal(result.rebuilt, result.before);
      },
    },
    {
      name: "usability: body search shows a safe excerpt and reveals nested matches",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            const { root } = window.usabilityIds;
            const needle = blk(
              "text",
              "prefix &lt;img src=x onerror=alert(1)&gt; needle suffix",
            );
            const toggle = blk("toggle", "closed", {
              expanded: false,
              children: [needle],
            });
            state.pages[root].blocks = [
              ...Array.from({ length: 90 }, () => blk("text", "padding")),
              toggle,
            ];
            renderEditor();
            openSearchModal("needle");
            const snippet = document.querySelector(".search-item-snippet");
            const excerpt = snippet.textContent,
              unsafeMarkup = !!snippet.querySelector("img");
            document.querySelector("#search-results .search-item").click();
            const target = document.querySelector(blockSelectorById(needle.id));
            const rect = target.getBoundingClientRect();
            const scroller = document
              .querySelector("#editor-scroll")
              .getBoundingClientRect();
            return {
              excerpt,
              unsafeMarkup,
              expanded: toggle.expanded,
              target: target.classList.contains("search-target"),
              visible:
                rect.top >= scroller.top && rect.bottom <= scroller.bottom,
              closed: searchOverlay.hidden,
            };
          }),
        );
        assert.match(result.excerpt, /needle/);
        assert.match(result.excerpt, /<img/);
        assert.equal(result.unsafeMarkup, false);
        assert.equal(result.expanded, true);
        assert.equal(result.target, true);
        assert.equal(result.visible, true);
        assert.equal(result.closed, true);
      },
    },
    {
      name: "usability: search excerpts respect scan limits and handle queries crossing blocks",
      run: async (page) => {
        const result = await evaluate(
          page,
          js(() => {
            const blocks = [
              blk("text", "alpha"),
              blk("text", "beta"),
              blk("text", "hidden needle"),
            ];
            const cross = flattenTextFromBlocksWithinBudget(
              blocks,
              2,
              "alpha beta",
            );
            const limited = flattenTextFromBlocksWithinBudget(
              blocks,
              2,
              "needle",
            );
            const unicode = flattenTextFromBlocksWithinBudget(
              [blk("text", "İ needle")],
              1,
              "needle",
            );
            return {
              crossText: cross.text,
              match: cross.match?.blockId,
              expected: blocks[0].id,
              limited: limited.exhausted,
              noMatch: !limited.match,
              unicode: unicode.match?.snippet,
            };
          }),
        );
        assert.equal(result.crossText, "alpha beta");
        assert.equal(result.match, result.expected);
        assert.equal(result.limited, true);
        assert.equal(result.noMatch, true);
        assert.match(result.unicode, /İ needle/);
      },
    },
    {
      name: "usability: trash confirmation includes the entire subtree and restoration preserves it",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            const { root, child, grand } = window.usabilityIds;
            const message = pageTrashMessage(root);
            deletePage(root);
            const deleted = [root, child, grand].every(
              (id) => !!state.pages[id].deletedAt,
            );
            restorePage(root);
            const restored = [root, child, grand].every(
              (id) => !state.pages[id].deletedAt,
            );
            return {
              message,
              deleted,
              restored,
              childParent: state.pages[child].parentId === root,
              grandParent: state.pages[grand].parentId === child,
            };
          }),
        );
        assert.match(result.message, /仕事/);
        assert.match(result.message, /2件/);
        assert.equal(result.deleted, true);
        assert.equal(result.restored, true);
        assert.equal(result.childParent, true);
        assert.equal(result.grandParent, true);
      },
    },
    {
      name: "usability: list indent/outdent retains rich text, descendants, selection and sibling order",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            const first = blk("bullet", "Parent"),
              second = blk("bullet", "<b>Child</b>", {
                children: [blk("todo", "existing nested")],
              }),
              third = blk("bullet", "Sibling");
            getCurrentPage().blocks = [first, second, third];
            renderEditor();
            const target = document.querySelector(
              blockEditableSelectorById(second.id),
            );
            target.focus();
            getSelection().setBaseAndExtent(
              target.firstChild.firstChild,
              1,
              target.firstChild.firstChild,
              4,
            );
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Tab",
                bubbles: true,
                cancelable: true,
              }),
            );
            const nested = first.children[0] === second,
              selected = getSelection().toString();
            const nestedSibling = blk("bullet", "Following");
            first.children.push(nestedSibling);
            renderEditor();
            const outdented = indentListBlock(second.id, true);
            const order = getCurrentPage().blocks.map((b) => b.id);
            const children = second.children.map((b) => b.content);
            return {
              nested,
              selected,
              outdented,
              order,
              expected: [first.id, second.id, third.id],
              children,
              content: second.content,
            };
          }),
        );
        assert.equal(result.nested, true);
        assert.equal(result.selected, "hil");
        assert.equal(result.outdented, true);
        assert.deepEqual(result.order, result.expected);
        assert.deepEqual(result.children, ["existing nested", "Following"]);
        assert.equal(result.content, "<b>Child</b>");
      },
    },
    {
      name: "usability: block reordering has a keyboard/menu alternative and boundary operations do nothing",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            const a = blk("text", "A"),
              b = blk("text", "B", { children: [] });
            getCurrentPage().blocks = [a, b];
            renderEditor();
            const firstBoundary = shiftBlock(a.id, -1),
              moved = shiftBlock(b.id, -1);
            const order = getCurrentPage().blocks.map((block) => block.content);
            showBlockContextMenu(
              { currentTarget: document.querySelector(".block-drag") },
              b,
            );
            const labels = [
              ...document.querySelectorAll("#context-menu button"),
            ].map((el) => el.getAttribute("aria-label"));
            return { firstBoundary, moved, order, labels };
          }),
        );
        assert.equal(result.firstBoundary, false);
        assert.equal(result.moved, true);
        assert.deepEqual(result.order, ["B", "A"]);
        assert.ok(result.labels.includes("上へ移動"));
        assert.ok(result.labels.includes("下へ移動"));
      },
    },
    {
      name: "usability: empty slash searches show guidance and standard Markdown quotes remain quotes",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(() => {
            getCurrentPage().blocks = [blk("text", "")];
            renderEditor();
            const el = document.querySelector("#blocks .block-content");
            el.focus();
            el.textContent = "/該当なし";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            const emptyMenu = !document.querySelector("#context-menu").hidden,
              guidance = document.querySelector("#context-menu").textContent;
            hideContextMenu();
            el.textContent = "> ";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return {
              emptyMenu,
              guidance,
              type: getCurrentPage().blocks[0].type,
            };
          }),
        );
        assert.equal(result.emptyMenu, true);
        assert.match(result.guidance, /該当するブロックがありません/);
        assert.equal(result.type, "quote");
      },
    },
    {
      name: "usability: move dialog remains accessible at phone and desktop sizes in both languages",
      run: async (page) => {
        for (const width of [320, 1280]) {
          await page.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 568,
            deviceScaleFactor: 1,
            mobile: false,
          });
          for (const language of ["ja", "en"]) {
            await reset(page);
            const result = await evaluate(
              page,
              `(${(async (language) => {
                state.uiLanguage = language;
                applyLanguage();
                showMovePageDialog(window.usabilityIds.root);
                await new Promise((resolve) => setTimeout(resolve, 200));
                const rect = document
                  .querySelector("#dialog-box")
                  .getBoundingClientRect();
                const focused = document.activeElement.id;
                document.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "Escape",
                    bubbles: true,
                    cancelable: true,
                  }),
                );
                return {
                  fits:
                    rect.left >= 0 &&
                    rect.right <= innerWidth &&
                    rect.top >= 0 &&
                    rect.bottom <= innerHeight,
                  focused,
                  closed: dialogOverlay.hidden,
                  language: document.documentElement.lang,
                  overflow: document.documentElement.scrollWidth > innerWidth,
                };
              }).toString()})(${JSON.stringify(language)})`,
            );
            assert.equal(result.fits, true);
            assert.equal(result.focused, "move-page-destination");
            assert.equal(result.closed, true);
            assert.equal(result.language, language);
            assert.equal(result.overflow, false);
          }
        }
        await page.send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
      },
    },
    {
      name: "usability: save shortcut opens HTML backup and status reflects successful and failed writes",
      run: async (page) => {
        await reset(page);
        const result = await evaluate(
          page,
          js(async () => {
            const el = document.querySelector("#blocks .block-content");
            el.focus();
            const key = new KeyboardEvent("keydown", {
              key: "s",
              metaKey: true,
              bubbles: true,
              cancelable: true,
            });
            el.dispatchEvent(key);
            const opened = !dialogOverlay.hidden,
              title = document.querySelector("#dialog-title").textContent;
            hideDialog(null);
            saveState();
            const pending = document.querySelector("#persistence-status")
              .dataset.kind;
            const saved = await _doSave({ force: true });
            const success = document.querySelector("#persistence-status")
              .dataset.kind;
            const failed = await _doSave({ force: true, maxPayloadBytes: 1 });
            const failure = document.querySelector("#persistence-status")
              .dataset.kind;
            await _doSave({ force: true });
            return {
              prevented: key.defaultPrevented,
              opened,
              title,
              pending,
              saved,
              success,
              failed,
              failure,
            };
          }),
        );
        assert.equal(result.prevented, true);
        assert.equal(result.opened, true);
        assert.equal(result.title, "HTMLバックアップ");
        assert.equal(result.pending, "pending");
        assert.equal(result.saved, true);
        assert.equal(result.success, "saved");
        assert.equal(result.failed, false);
        assert.equal(result.failure, "error");
      },
    },
  ];
}
