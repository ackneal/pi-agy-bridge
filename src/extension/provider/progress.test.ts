import assert from "node:assert/strict";
import test from "node:test";
import { ProgressStatus } from "./progress.ts";

test("shared progress restores active entries and ignores stale finish calls", async (t) => {
  for (const row of [
    { name: "nested completion", outerFirst: false, clear: false, expected: ["outer", "inner", "outer", undefined] },
    { name: "out of order completion", outerFirst: true, clear: false, expected: ["outer", "inner", undefined] },
    { name: "shutdown before completion", outerFirst: false, clear: true, expected: ["outer", "inner", undefined] },
  ]) {
    await t.test(row.name, () => {
      const messages: Array<string | undefined> = [];
      const progress = new ProgressStatus();
      const ui = { setStatus: (key: string, message: string | undefined) => {
        assert.equal(key, "agy-bridge");
        messages.push(message);
      } };
      const outer = progress.show(ui, "outer");
      const inner = progress.show(ui, "inner");
      if (row.clear) progress.clear();
      if (row.outerFirst) { outer(); inner(); }
      else { inner(); outer(); }
      outer();
      inner();
      assert.deepEqual(messages, row.expected);
    });
  }
});

test("clearing progress clears every UI", () => {
  const progress = new ProgressStatus();
  const messages: Array<Array<string | undefined>> = [[], []];
  for (const output of messages) progress.show({ setStatus: (_key, message) => { output.push(message); } }, "active");
  progress.clear();
  assert.deepEqual(messages, [["active", undefined], ["active", undefined]]);
});
