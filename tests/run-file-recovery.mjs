#!/usr/bin/env node
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {
  launchBrowser,
  stopBrowser,
  openPage,
  evaluate,
  js,
} from "./run-browser.mjs";

// HTTP経由の連続運転試験に加え、配布アプリをfile://で開いた場合も検証する。
// 一時ブラウザプロファイルを使い、ユーザーの保存領域は読み取りも削除もしない。
let browser;
let page;
let profilePath;
const restart = async () => {
  const exited = new Promise((resolve) => browser.proc.once("exit", resolve));
  browser.proc.kill("SIGKILL");
  await exited;
  page.close();
  browser = await launchBrowser({ profilePath });
  page = await openPage(browser.port);
};
try {
  browser = await launchBrowser();
  profilePath = browser.userDataDir;
  page = await openPage(browser.port);
  const expected = await evaluate(
    page,
    js(async () => {
      const api = window.__LeafNoteTest;
      const draft = api.createInitialState();
      draft.workspaceName = "file protocol recovery";
      draft.pages[draft.currentPageId].blocks = [
        api.blk("text", "committed note — 保存済み"),
      ];
      api.setState(draft);
      api.renderAll();
      if (!(await api._doSave({ force: true })))
        throw new Error("Initial save failed");
      return api.getState();
    }),
  );
  await restart();
  assert.deepEqual(
    await evaluate(page, "window.__LeafNoteTest.getState()"),
    expected,
  );
  assert.equal(
    await evaluate(
      page,
      js(() => _doSave({ force: true })),
    ),
    true,
  );
  console.log(
    "ok - file:// document survives a real browser SIGKILL and reacquires its writer lease",
  );

  await evaluate(
    page,
    js(() => {
      const api = window.__LeafNoteTest;
      const editable = document.querySelector("[data-block-id]");
      editable.textContent = "not committed yet — 最後の未保存入力";
      editable.dispatchEvent(new Event("input", { bubbles: true }));
      // 遅延保存を保留し、書き込み前に確実に強制終了させる。
      // 実際の入力から予約された保存までの時間帯を再現する。
      clearTimeout(_saveTimer);
      _saveTimer = null;
      return true;
    }),
  );
  await restart();
  assert.deepEqual(
    await evaluate(page, "window.__LeafNoteTest.getState()"),
    expected,
  );
  console.log(
    "ok - crash before a pending save preserves the last commit; uncommitted input is lost as expected",
  );
} finally {
  page?.close();
  await stopBrowser(browser);
  if (profilePath)
    await rm(profilePath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
}
