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

test("changing a status UI restores pending operations on both UIs", () => {
  for (const row of [
    { name: "restore pending doctors", pending: true, broken: false, expectedA: ["doctor A", "download", "doctor A"], expectedB: ["doctor B", "verify", "doctor B"] },
    { name: "clear without pending operations", pending: false, broken: false, expectedA: ["download", undefined], expectedB: ["verify", undefined] },
    { name: "failed old UI render does not block migration", pending: true, broken: true, expectedA: ["download"], expectedB: ["doctor B", "verify", "doctor B"] },
  ]) {
    const progress = new ProgressStatus();
    const aMessages: Array<string | undefined> = [];
    const bMessages: Array<string | undefined> = [];
    const uiA = { setStatus: (_key: string, message: string | undefined) => {
      if (row.broken && message === "doctor A") throw new Error("unavailable");
      aMessages.push(message);
    } };
    const uiB = { setStatus: (_key: string, message: string | undefined) => bMessages.push(message) };
    const id = Symbol();
    if (row.pending) {
      progress.show(uiA, "doctor A");
      progress.show(uiB, "doctor B");
    }

    progress.set(id, uiA, "download");
    progress.set(id, uiB, "verify");
    progress.set(id, uiB, undefined);
    progress.set(id, uiB, undefined);

    assert.deepEqual(aMessages, row.expectedA, row.name);
    assert.deepEqual(bMessages, row.expectedB, row.name);
  }
});

test("undefined UI removes old status and UI errors do not prevent cleanup", () => {
  for (const row of [
    { name: "undefined UI", uiThrows: false, expected: ["old", undefined] },
    { name: "throwing UI", uiThrows: true, expected: ["old"] },
  ]) {
    const progress = new ProgressStatus();
    const messages: Array<string | undefined> = [];
    const ui = { setStatus: (_key: string, message: string | undefined) => {
      if (row.uiThrows && message === undefined) throw new Error("unavailable");
      messages.push(message);
    } };
    const id = Symbol();

    progress.set(id, ui, "old");
    const displayed = progress.set(id, undefined, "new");
    progress.set(id, ui, undefined);

    assert.equal(displayed, false, "clearing an old UI does not display the new message");

    assert.deepEqual(messages, row.expected, row.name);
  }
});

test("same-UI updates retain insertion priority", () => {
  const progress = new ProgressStatus();
  const messages: Array<string | undefined> = [];
  const ui = { setStatus: (_key: string, message: string | undefined) => messages.push(message) };
  const first = Symbol();
  const last = Symbol();
  progress.set(first, ui, "first");
  progress.set(last, ui, "last");
  progress.set(first, ui, "updated");
  assert.deepEqual(messages, ["first", "last", "last"]);
});

test("clearing progress clears every UI", () => {
  const progress = new ProgressStatus();
  const messages: Array<Array<string | undefined>> = [[], []];
  for (const output of messages) progress.show({ setStatus: (_key, message) => { output.push(message); } }, "active");
  progress.clear();
  assert.deepEqual(messages, [["active", undefined], ["active", undefined]]);
});
