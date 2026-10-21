import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// オリジンを分けてテストデータを隔離する。Web LocksとIndexedDBは常に実装本体を使い、
// 障害の差し込みは明示したシナリオに限定する。
export async function runStorageWriterRegressions(
  browser,
  { openPage, evaluate, js, jsWithArgs },
) {
  const source = await readFile(
    process.env.STORAGE_WRITER_SOURCE ||
      (existsSync(new URL("../leaf-note.html", import.meta.url))
        ? new URL("../leaf-note.html", import.meta.url)
        : new URL("../LeafNote.html", import.meta.url)),
    "utf8",
  );
  const servers = [],
    pages = [];
  const close = async (page) => {
    // 検証後に合成テストデータの編集だけを破棄し、beforeunloadの確認画面を防ぐ。
    // ページ移動で実行コンテキストと保存権は破棄される。
    await evaluate(
      page,
      js(() => {
        _lastPersistedStateJSON = JSON.stringify(state);
      }),
    );
    await page.send("Page.navigate", { url: "about:blank" });
    page.close();
  };
  const tab = async (url) => {
    const page = await openPage(browser.port, { url });
    pages.push(page);
    return page;
  };
  const fixture = async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(source);
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/LeafNote.html?test=1`;
    const first = await tab(url);
    assert.equal(
      await evaluate(
        first,
        js(async () => {
          const api = window.__LeafNoteTest,
            draft = api.createInitialState();
          draft.pages[draft.currentPageId].blocks = [
            api.blk("text", "original"),
          ];
          // 正規化した文書を保存し、次のタブが起動時に修復・保存しないようにする。
          // 起動時の保存が発生すると、その書き込みで保存権を取得してしまう。
          api.setState(JSON.parse(JSON.stringify(draft)));
          return _doSave({ force: true });
        }),
      ),
      true,
    );
    const second = await tab(url);
    for (const page of [first, second])
      await evaluate(
        page,
        js(() => {
          // 他タブへの通知の欠落・遅延を再現する。最初のhelloによる通信が終わる前でも、
          // ブラウザの排他制御だけで正しい状態を保てることを確認する。
          _storageChannel?.close();
          _storageChannel = null;
          _otherStorageTabsSeen = false;
        }),
      );
    return { first, second, url };
  };
  const edit = (page, body) =>
    evaluate(
      page,
      jsWithArgs((body) => {
        getCurrentPage().blocks[0].content = body;
        saveState();
        clearTimeout(_saveTimer);
        _saveTimer = null;
      }, body),
    );
  const protectedLoser = (page) =>
    evaluate(
      page,
      js(async () => {
        const localBefore = localStorage.getItem(STATE_STORAGE_KEY);
        const saved = await _doSave({ force: true });
        flushStateToLocalStorageSync();
        const unload = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(unload);
        await _doSave({ force: true });
        return {
          saved,
          body: getCurrentPage().blocks[0].content,
          unsaved: _hasUnsavedState(),
          localUnchanged:
            localBefore === localStorage.getItem(STATE_STORAGE_KEY),
          closePrevented: unload.defaultPrevented,
          statusVisible: !document.querySelector("#save-status").hidden,
        };
      }),
    );
  try {
    {
      const { first, second, url } = await fixture();
      const primary = await evaluate(
        first,
        js(async () => {
          const page = getCurrentPage();
          // 実際の6 MiBの添付はBase64化するとChromiumのlocalStorageの上限を超えるが、
          // IndexedDBへの保存は成功する。
          page.blocks.push(
            blk("file", "", {
              fileName: "synthetic.txt",
              fileType: "text/plain",
              fileSize: 6 * 1024 * 1024,
              fileDataUrl:
                "data:text/plain;base64," + "eHh4".repeat(2 * 1024 * 1024),
            }),
          );
          page.blocks[0].content = "primary committed";
          saveState();
          clearTimeout(_saveTimer);
          _saveTimer = null;
          const saved = await _doSave();
          return {
            saved,
            mirrorBody: JSON.parse(localStorage.getItem(STATE_STORAGE_KEY))
              .pages[state.currentPageId].blocks[0].content,
          };
        }),
      );
      assert.deepEqual(primary, { saved: true, mirrorBody: "original" });
      await evaluate(
        second,
        js(() => {
          indexedDB.open = () => {
            throw new Error("IndexedDB unavailable");
          };
        }),
      );
      await edit(second, "fallback edit");
      assert.deepEqual(await protectedLoser(second), {
        saved: false,
        body: "fallback edit",
        unsaved: true,
        localUnchanged: true,
        closePrevented: true,
        statusVisible: true,
      });
      const committed = await evaluate(
        first,
        js(async () => {
          const saved = await loadStateAsync();
          const db = await openDB();
          const req = db
            .transaction(DB_STORE, "readonly")
            .objectStore(DB_STORE)
            .get(DB_PREVIOUS_STATE_KEY);
          const previous = await new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          db.close();
          return {
            body: saved.pages[saved.currentPageId].blocks[0].content,
            previousBody:
              previous.pages[previous.currentPageId].blocks[0].content,
          };
        }),
      );
      assert.deepEqual(committed, {
        body: "primary committed",
        previousBody: "original",
      });
      await close(first);
      await close(second);
      const reopened = await tab(url);
      assert.equal(
        await evaluate(
          reopened,
          js(() => getCurrentPage().blocks[0].content),
        ),
        "primary committed",
      );
      await edit(reopened, "after reopening");
      assert.equal(
        await evaluate(
          reopened,
          js(() => _doSave()),
        ),
        true,
      );
      await close(reopened);
      console.log(
        "ok - writer lease protects an IndexedDB commit and checkpoint when the real localStorage mirror is full and notifications are absent",
      );
    }
    for (const ownerStore of ["IndexedDB", "localStorage fallback"]) {
      const { first, second } = await fixture();
      await evaluate(
        second,
        js(() => {
          const get = Storage.prototype.getItem,
            cached = localStorage.getItem(STATE_STORAGE_KEY);
          window.restoreStorageRead = () => {
            Storage.prototype.getItem = get;
          };
          Storage.prototype.getItem = function (key) {
            return this === localStorage && key === STATE_STORAGE_KEY
              ? cached
              : get.call(this, key);
          };
          window.addEventListener(
            "storage",
            (event) => event.stopImmediatePropagation(),
            true,
          );
          indexedDB.open = () => {
            throw new Error("IndexedDB unavailable");
          };
        }),
      );
      if (ownerStore === "localStorage fallback")
        await evaluate(
          first,
          js(() => {
            indexedDB.open = () => {
              throw new Error("IndexedDB unavailable");
            };
          }),
        );
      await edit(first, "owner committed");
      await edit(second, "stale edit");
      assert.equal(
        await evaluate(
          first,
          js(() => _doSave()),
        ),
        true,
      );
      assert.deepEqual(await protectedLoser(second), {
        saved: false,
        body: "stale edit",
        unsaved: true,
        localUnchanged: true,
        closePrevented: true,
        statusVisible: true,
      });
      await evaluate(
        second,
        js(() => window.restoreStorageRead()),
      );
      assert.equal(
        await evaluate(
          second,
          js(() => {
            const s = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY));
            return s.pages[s.currentPageId].blocks[0].content;
          }),
        ),
        "owner committed",
      );
      await close(first);
      await close(second);
      console.log(
        `ok - writer lease blocks a fallback tab with a stale localStorage view (${ownerStore} owner)`,
      );
    }
    {
      const { first, second } = await fixture();
      await edit(second, "lifecycle edit");
      const result = await evaluate(
        second,
        js(() => {
          const before = localStorage.getItem(STATE_STORAGE_KEY);
          flushStateToLocalStorageSync();
          return {
            unchanged: before === localStorage.getItem(STATE_STORAGE_KEY),
            unsaved: _hasUnsavedState(),
          };
        }),
      );
      assert.deepEqual(result, { unchanged: true, unsaved: true });
      await close(first);
      await close(second);
      console.log(
        "ok - a tab without a writer lease cannot perform a synchronous lifecycle overwrite before peer discovery",
      );
    }
    {
      const { first, second, url } = await fixture();
      // 2つ目のタブが最新状態を読み込んでいても、保存権によって今後の競合保存を防ぐ。
      // 一度拒否されたタブが古い状態のまま保存権を引き継がないことも確認する。
      await edit(second, "denied edit");
      assert.equal(
        await evaluate(
          second,
          js(() => _doSave()),
        ),
        false,
      );
      await close(first);
      assert.equal(
        await evaluate(
          second,
          js(() => _doSave({ force: true })),
        ),
        false,
      );
      await close(second);
      const reopened = await tab(url);
      await edit(reopened, "new owner");
      assert.equal(
        await evaluate(
          reopened,
          js(() => _doSave()),
        ),
        true,
      );
      assert.equal(
        await evaluate(
          reopened,
          js(async () => {
            const s = await loadStateAsync();
            return s.pages[s.currentPageId].blocks[0].content;
          }),
        ),
        "new owner",
      );
      await close(reopened);
      console.log(
        "ok - closing an owner releases its lease, but a denied tab must reload before taking ownership",
      );
    }
    {
      const { first, second } = await fixture();
      // 所有タブは、別タブが初めて保存を試みる前に閉じることもある。
      // 別タブは起動時点で保存権の拒否を記録していなければならない。
      await close(first);
      await evaluate(
        second,
        js(async () => {
          for (let i = 0; i < 200; i++) {
            if (
              !(await navigator.locks.query()).held.some(
                (lock) => lock.name === `${STATE_STORAGE_KEY}:writer`,
              )
            )
              return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("Closed owner did not release its writer lease");
        }),
      );
      await edit(second, "edit from previously loaded tab");
      await evaluate(
        second,
        js(() => {
          indexedDB.open = () => {
            throw new Error("IndexedDB unavailable");
          };
        }),
      );
      assert.deepEqual(await protectedLoser(second), {
        saved: false,
        body: "edit from previously loaded tab",
        unsaved: true,
        localUnchanged: true,
        closePrevented: true,
        statusVisible: true,
      });
      await close(second);
      console.log(
        "ok - startup ownership prevents stale takeover when the owner closes before another tab first saves",
      );
    }
  } finally {
    pages.forEach((page) => page.close());
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      ),
    );
  }
}
