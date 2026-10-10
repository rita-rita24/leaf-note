import assert from "node:assert/strict";
import { openTestPage } from "./test-page.mjs";
const [source = "leaf-note.html", engine = "chrome"] = process.argv.slice(2);
const page = await openTestPage({
  source,
  engine,
  ready: "window.__LeafNoteTest?.isReady()",
});
try {
  const result = await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    setSidebarCollapsed(false);
    const resizer = document.querySelector("#sidebar-resizer"),
      sidebar = document.querySelector("#sidebar"),
      style = document.documentElement.style;
    const pointer = resizer.getAttribute("role") === "separator";
    const originalCapture = resizer.setPointerCapture,
      originalHasCapture = resizer.hasPointerCapture;
    if (pointer) {
      resizer.setPointerCapture = () => {};
      resizer.hasPointerCapture = () => false;
    }
    const event = (type, x = 260) =>
      pointer
        ? new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            pointerId: 37,
            clientX: x,
          })
        : new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: type === "mouseup" ? 0 : 1,
            clientX: x,
          });
    const begin = () =>
      resizer.dispatchEvent(event(pointer ? "pointerdown" : "mousedown"));
    const move = (x) =>
      document.dispatchEvent(event(pointer ? "pointermove" : "mousemove", x));
    const end = () =>
      document.dispatchEvent(event(pointer ? "pointerup" : "mouseup"));
    const width = () => parseInt(style.getPropertyValue("--sidebar-width"), 10);
    const saved = () => localStorage.getItem(SIDEBAR_WIDTH_KEY);
    let writes = 0;
    const originalSet = style.setProperty;
    style.setProperty = function (name, ...args) {
      if (name === "--sidebar-width") writes++;
      return originalSet.call(this, name, ...args);
    };
    try {
      applySidebarWidth(260);
      await frame();
      await frame();
      writes = 0;
      begin();
      for (let i = 0; i < 60; i++) move(261 + i);
      const deferred = width() === 260;
      end();
      const final =
        width() === 320 &&
        saved() === "320" &&
        !sidebar.classList.contains("resizing") &&
        writes === 1;
      await frame();
      await frame();
      const noLateWrite = writes === 1;
      move(400);
      const inactive = width() === 320;
      applySidebarWidth(260);
      begin();
      move(340);
      await frame();
      await frame();
      const frameLatest = width() === 340;
      end();
      applySidebarWidth(260);
      begin();
      move(900);
      end();
      const max = width() === 480 && saved() === "480";
      applySidebarWidth(260);
      begin();
      move(-400);
      end();
      const min = width() === 180 && saved() === "180";
      applySidebarWidth(260);
      begin();
      move(355);
      window.dispatchEvent(new Event("blur"));
      const blur =
        width() === 355 &&
        saved() === "355" &&
        !sidebar.classList.contains("resizing");
      move(420);
      const blurStopped = width() === 355;
      applySidebarWidth(260);
      begin();
      move(345);
      const hiddenDescriptor = Object.getOwnPropertyDescriptor(
        document,
        "hidden",
      );
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      if (hiddenDescriptor)
        Object.defineProperty(document, "hidden", hiddenDescriptor);
      else delete document.hidden;
      const hidden =
        width() === 345 &&
        saved() === "345" &&
        !sidebar.classList.contains("resizing");
      applySidebarWidth(260);
      begin();
      move(360);
      resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      end();
      await frame();
      await frame();
      const reset = width() === 260 && saved() === "260";
      let repeated = true;
      for (let i = 0; i < 10; i++) {
        applySidebarWidth(260);
        begin();
        move(270 + i);
        end();
        move(450);
        repeated &&=
          width() === 270 + i &&
          saved() === String(270 + i) &&
          !sidebar.classList.contains("resizing");
      }
      const request = window.requestAnimationFrame,
        cancel = window.cancelAnimationFrame;
      let fallback = false;
      try {
        window.requestAnimationFrame = undefined;
        window.cancelAnimationFrame = undefined;
        const values = [];
        const update = createLatestFrameUpdate((x) => values.push(x));
        update.queue(1);
        update.queue(2);
        update.flush();
        fallback = JSON.stringify(values) === "[1,2]";
      } finally {
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
      }
      return {
        deferred,
        final,
        noLateWrite,
        inactive,
        frameLatest,
        max,
        min,
        blur,
        blurStopped,
        hidden,
        reset,
        repeated,
        fallback,
      };
    } finally {
      style.setProperty = originalSet;
      if (pointer) {
        resizer.setPointerCapture = originalCapture;
        resizer.hasPointerCapture = originalHasCapture;
      }
    }
  });
  console.log("Browser:", engine, page.version);
  console.log(JSON.stringify(result));
  for (const [name, value] of Object.entries(result))
    assert.equal(value, true, name);
  console.log(
    "PASS: latest frame, final readback, bounds, reset, blur/hidden cleanup, repeat and fallback",
  );
} finally {
  await page.close();
}
