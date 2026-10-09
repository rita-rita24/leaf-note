import { openTestPage } from "./test-page.mjs";
import assert from "node:assert/strict";
const source = process.argv[2] || "Maskinger.html",
  engine = process.argv[3] || "chrome";
const page = await openTestPage({
  source,
  engine,
  ready: "!!window.__MaskingerTest",
});
try {
  console.log("Browser:", engine, page.version);
  const results = await page.evaluate(async () => {
    const api = window.__MaskingerTest,
      bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length,
      check = (value, message) => {
        if (!value) throw new Error(message);
      };
    const done = [];
    const originals = [
      '雪😀\\\"\n\u0000',
      "lone \ud800",
      " combining e\u0301",
      "slash \\ and tab\t",
    ];
    const items = originals.map((value, index) => ({
      _placeholder: "MASK_TEXT_" + String(index + 1).padStart(4, "0"),
      _type: "TEXT",
      _original: value,
    }));
    api.replaceMappings(items);
    check(
      JSON.stringify(api.mappings()) === JSON.stringify(items),
      "Unicode/control serialization changed",
    );
    check(
      api.restore(items.map((x) => x._placeholder).join("|")).text ===
        originals.join("|"),
      "Unicode restoration differs",
    );
    done.push("Unicode/control/surrogate serialization and restoration");
    const first = [
        {
          _placeholder: "MASK_TEXT_0001",
          _type: "TEXT",
          _original: "previous original",
        },
      ],
      second = [{ ...first[0], _original: "replacement original" }];
    api.replaceMappings(first);
    check(
      api.restore(first[0]._placeholder).text === first[0]._original,
      "first lookup incorrect",
    );
    api.replaceMappings(second);
    check(
      api.restore(second[0]._placeholder).text === second[0]._original,
      "same-size replacement reused stale lookup",
    );
    done.push("same-size replacement invalidates lookup and rows");
    api.clear();
    check(
      api.restore(first[0]._placeholder).unresolved === 1,
      "clear retained previous lookup",
    );
    done.push("clear drops previous restoration lookup");
    const limits = api.limits(),
      large = [];
    let last;
    for (let i = 1; i <= limits.maxMappings; i++) {
      const prefix = "row" + i + ":",
        item = {
          _placeholder: "MASK_TEXT_" + String(i).padStart(4, "0"),
          _type: "TEXT",
          _original:
            prefix + "x".repeat(limits.mappingOriginalMaxBytes - prefix.length),
        };
      if (bytes([...large, item]) > limits.storageMaxBytes) {
        last = { ...item, _original: "" };
        const padding = limits.storageMaxBytes - bytes([...large, last]);
        check(
          padding >= 0 && padding <= limits.mappingOriginalMaxBytes,
          "invalid exact-boundary fixture",
        );
        last._original = "z".repeat(padding);
        large.push(last);
        break;
      }
      large.push(item);
    }
    check(
      bytes(large) === limits.storageMaxBytes,
      "fixture did not reach exact UTF-8 storage boundary",
    );
    check(
      api.replaceMappings(large).loaded === large.length,
      "exact boundary rejected",
    );
    const before = JSON.stringify(api.mappings()),
      result = api.mask("new-email@example.com");
    check(
      result.rejected && result.violation.code === "mapping_storage_bytes",
      "over-boundary mapping accepted",
    );
    check(
      JSON.stringify(api.mappings()) === before,
      "rejection changed accepted mappings",
    );
    check(
      JSON.stringify(
        JSON.parse(sessionStorage.getItem("maskinger.activeMappings.v2")),
      ) === before,
      "rejection changed persisted mappings",
    );
    check(
      api.restore(last._placeholder).text === last._original,
      "rollback lookup wrong",
    );
    done.push(
      "exact storage boundary, rejection rollback, persisted data and lookup",
    );
    api.clear();
    const source = document.querySelector("#source-input"),
      body = document.querySelector("#mapping-body");
    source.value = "same@example.com";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    const row = body.firstElementChild;
    source.value = "same@example.com latest";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    check(body.firstElementChild === row, "unchanged mapping table rebuilt");
    check(
      api.restore(document.querySelector("#masked-output").value).text ===
        source.value,
      "repeat restoration wrong",
    );
    done.push("repeated input reuses rows without changing restored output");
    api.clear();
    return done;
  });
  assert.equal(results.length, 5);
  for (const result of results) console.log("PASS:", result);
} finally {
  await page.close();
}
