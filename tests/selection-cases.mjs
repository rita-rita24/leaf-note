export async function selectionCases() {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const settle = async () => {
    await frame();
    await frame();
    await frame();
  };
  const scroll = document.querySelector("#editor-scroll");
  let start, current;
  const reference = () => {
    const sr = scroll.getBoundingClientRect(),
      bottom = current.y - sr.top + scroll.scrollTop,
      top = Math.min(start.docY, bottom),
      end = Math.max(start.docY, bottom);
    const candidates = [...document.querySelectorAll("#blocks .block")].filter(
      (el) => {
        const target = [
          "toggle",
          "toggle_h1",
          "toggle_h2",
          "toggle_h3",
        ].includes(el.dataset.type)
          ? el.querySelector(":scope>.toggle-header") || el
          : el;
        const rect = target.getBoundingClientRect();
        return !(
          rect.bottom + scroll.scrollTop - sr.top < top ||
          rect.top + scroll.scrollTop - sr.top > end
        );
      },
    );
    const set = new Set(candidates);
    return candidates
      .filter((el) => {
        let parent = el.parentElement.closest("#blocks .block");
        while (parent) {
          if (set.has(parent)) return false;
          parent = parent.parentElement.closest("#blocks .block");
        }
        return true;
      })
      .map((el) => el.dataset.id);
  };
  const begin = () => {
    BlockSelection.clear();
    scroll.scrollTop = 0;
    const first = document
        .querySelector("#blocks>.block")
        .getBoundingClientRect(),
      sr = scroll.getBoundingClientRect();
    start = {
      x: first.right + 8,
      y: first.top + 2,
      docY: first.top + 2 - sr.top,
    };
    scroll.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: start.x,
        clientY: start.y,
      }),
    );
  };
  const move = () => {
    const r = document
      .querySelectorAll("#blocks>.block")[5]
      .getBoundingClientRect();
    current = {
      x: r.left + 30,
      y: Math.min(r.bottom - 2, scroll.getBoundingClientRect().bottom - 80),
    };
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        clientX: current.x,
        clientY: current.y,
        buttons: 1,
      }),
    );
  };
  const check = (name) => {
    const expected = reference(),
      actual = BlockSelection.getSelectedIds();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error(
        name + ": expected " + expected.length + " actual " + actual.length,
      );
    return name;
  };
  const draft = createInitialState(),
    page = draft.pages[draft.currentPageId];
  page.blocks = Array.from({ length: 40 }, (_, i) =>
    blk("text", "Wrapping selection " + i),
  );
  const toggle = blk("toggle", "Parent toggle");
  toggle.children = [blk("text", "Nested one"), blk("text", "Nested two")];
  toggle.expanded = true;
  page.blocks.splice(3, 0, toggle);
  window.__LeafNoteTest.setState(draft);
  renderAll();
  await document.fonts.ready;
  await settle();
  const done = [];
  begin();
  move();
  await settle();
  done.push(check("initial nested selection"));
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  BlockSelection.clear();
  const children = document.querySelectorAll(".toggle-children > .block");
  const childFirst = children[0].getBoundingClientRect(),
    childLast = children[1].getBoundingClientRect(),
    canvas = scroll.getBoundingClientRect();
  start = {
    x: childFirst.right + 8,
    y: childFirst.top + 2,
    docY: childFirst.top + 2 - canvas.top + scroll.scrollTop,
  };
  scroll.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: start.x,
      clientY: start.y,
    }),
  );
  current = { x: childFirst.left + 30, y: childLast.bottom - 2 };
  window.dispatchEvent(
    new MouseEvent("mousemove", {
      clientX: current.x,
      clientY: current.y,
      buttons: 1,
    }),
  );
  await settle();
  done.push(check("nested children select without their toggle header"));
  if (BlockSelection.getSelectedIds().length !== 2)
    throw new Error("Nested child fixture did not select both children");
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  begin();
  move();
  await settle();

  scroll.scrollTop = 60;
  move();
  await settle();
  done.push(check("scroll positions remain fresh"));
  document.querySelector("#blocks>.block .block-content").textContent =
    "wrapping ".repeat(200);
  move();
  await settle();
  done.push(check("character data invalidates layout"));
  document.querySelector("#blocks").style.width = "340px";
  move();
  await settle();
  done.push(check("width change and wrapping invalidate layout"));
  document.querySelector("#blocks>.block").style.height = "170px";
  move();
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  done.push(check("same-task mutation and final mouseup are fresh"));
  document.querySelector("#blocks").style.width = "";
  document.querySelector("#blocks>.block").style.height = "";
  begin();
  move();
  await settle();
  const first = document.querySelector("#blocks>.block");
  const image = document.createElement("img");
  image.style.cssText = "display:block;height:120px;width:100px";
  first.append(image);
  image.dispatchEvent(new Event("load"));
  move();
  await settle();
  done.push(check("late image dimensions invalidate layout"));
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  image.remove();
  begin();
  move();
  await settle();
  window.dispatchEvent(new Event("blur"));
  if (
    document.body.classList.contains("block-selecting") ||
    document.querySelector("#selection-marquee").style.display !== "none"
  )
    throw Error("blur left active drag");
  const selected = JSON.stringify(BlockSelection.getSelectedIds());
  window.dispatchEvent(
    new MouseEvent("mousemove", { clientX: 0, clientY: 0, buttons: 1 }),
  );
  await settle();
  if (JSON.stringify(BlockSelection.getSelectedIds()) !== selected)
    throw Error("blur failed to cancel pending updates");
  done.push("blur ends drag and cancels pending work");
  const large = createInitialState();
  large.pages[large.currentPageId].blocks = Array.from(
    { length: 1000 },
    (_, i) => blk("text", "Block " + i),
  );
  window.__LeafNoteTest.setState(large);
  renderAll();
  await settle();
  const original = Element.prototype.getBoundingClientRect;
  let reads = 0;
  Element.prototype.getBoundingClientRect = function () {
    reads++;
    return original.call(this);
  };
  try {
    begin();
    for (let i = 0; i < 20; i++) {
      move();
      await settle();
    }
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    if (reads > 5000)
      throw Error("Stable drag kept rereading all geometry: " + reads);
    done.push("1000 blocks: 20 updates reuse geometry (" + reads + " reads)");
  } finally {
    Element.prototype.getBoundingClientRect = original;
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    BlockSelection.clear();
  }
  const observer = window.ResizeObserver;
  try {
    window.ResizeObserver = undefined;
    begin();
    move();
    await settle();
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    done.push(check("missing ResizeObserver keeps fresh geometry fallback"));
  } finally {
    window.ResizeObserver = observer;
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    BlockSelection.clear();
  }
  return done;
}
