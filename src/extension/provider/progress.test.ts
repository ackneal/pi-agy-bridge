import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { Bridge } from "./provider.ts";
import { AgyAuthentication } from "./auth.ts";
import { ProgressStatus } from "./progress.ts";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";

useAuthHomeFixture();

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

test("changing a status UI restores pending operations on both UIs", async (t) => {
  for (const row of [
    { name: "restore pending doctors", pending: true, broken: false, expectedA: ["doctor A", "download", "doctor A"], expectedB: ["doctor B", "verify", "doctor B"] },
    { name: "clear without pending operations", pending: false, broken: false, expectedA: ["download", undefined], expectedB: ["verify", undefined] },
    { name: "failed old UI render does not block migration", pending: true, broken: true, expectedA: ["download"], expectedB: ["doctor B", "verify", "doctor B"] },
  ]) {
    await t.test(row.name, () => {
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
    });
  }
});

test("undefined UI removes old status and UI errors do not prevent cleanup", async (t) => {
  for (const row of [
    { name: "undefined UI", uiThrows: false, expected: ["old", undefined] },
    { name: "throwing UI", uiThrows: true, expected: ["old"] },
  ]) {
    await t.test(row.name, () => {
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
    });
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

test("ACP download progress temporarily replaces and restores Doctor status", async (t) => {
  type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const commands = new Map<string, Handler>();
  let shutdown!: () => Promise<void>;
  const statuses: Array<[string, string | undefined]> = [];
  const driver = new AcpDriver();
  const bridge = new Bridge({
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
    registerProvider() {},
    on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
    sendMessage() {},
  } as unknown as ExtensionAPI, driver);
  t.mock.method(driver, "usage", async () => {
    for (const phase of ["validate", "download", "verify", "extract", "complete"] as const) {
      driver.onInstallationProgress?.({ phase, message: phase, version: "1.0", platform: "test" });
    }
    return undefined;
  });
  t.mock.method(driver, "detectExecutable", () => undefined);
  t.mock.method(driver.authentication, "probe", async () => false);
  bridge.start();
  t.after(async () => { await shutdown(); });

  await commands.get("agy-bridge:doctor")!("", {
    hasUI: true,
    ui: { setStatus: (key: string, message: string | undefined) => statuses.push([key, message]), notify() {} },
  } as unknown as ExtensionCommandContext);

  const messages = statuses.map(([, message]) => message);
  assert.equal(messages[0], "Checking Antigravity ACP diagnostics…");
  assert.ok(messages.includes("download"));
  assert.ok(messages.includes("verify"));
  assert.ok(messages.includes("extract"));
  assert.ok(!messages.includes("validate"));
  assert.ok(!messages.includes("complete"));
  assert.ok(messages.filter((message) => message === "Checking Antigravity ACP diagnostics…").length >= 2);
  assert.equal(messages.at(-1), undefined);
  assert.ok(statuses.every(([key]) => key === "agy-bridge"));
});

test("overlapping commands preserve the newest active footer operation", async (t) => {
  for (const scenario of [
    { name: "doctor finishes before switch discovery", first: "doctor", releaseFirst: "doctor" },
    { name: "older doctor finishes after switch discovery", first: "doctor", releaseFirst: "switch" },
    { name: "newer doctor restores pending switch progress", first: "switch", releaseFirst: "doctor" },
  ] as const) {
    await t.test(scenario.name, async (t) => {
      type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      const commands = new Map<string, Handler>();
      const statuses: Array<string | undefined> = [];
      const gates = new Map<string, { promise: Promise<void>; release: () => void; entered: Promise<void>; markEntered: () => void }>();
      for (const name of ["doctor", "switch"]) {
        let release!: () => void;
        let markEntered!: () => void;
        const promise = new Promise<void>((resolve) => { release = resolve; });
        const entered = new Promise<void>((resolve) => { markEntered = resolve; });
        gates.set(name, { promise, release, entered, markEntered });
      }
      const bridge = new Bridge({
        registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
        registerProvider: () => {}, on: () => {}, sendMessage: () => {},
      } as unknown as ExtensionAPI, new CliDriver());
      t.after(async () => {
        gates.forEach((gate) => gate.release());
        await Promise.allSettled([doctorTask, switchTask].filter((task): task is Promise<void> => task !== undefined));
        await bridge.liveSessions.disposeAll();
      });
      bridge.start();
      t.mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
      const doctorGate = gates.get("doctor")!;
      const switchGate = gates.get("switch")!;
      const doctorUsage = t.mock.method(bridge.driver, "usage", async () => {
        doctorGate.markEntered();
        await doctorGate.promise;
        return undefined;
      });
      t.mock.method(bridge.driver, "detectExecutable", () => undefined);
      let detections = 0;
      t.mock.method(AcpDriver.prototype, "detectExecutable", () => ++detections === 1 ? "/unused/acp" : undefined);
      t.mock.method(AcpDriver.prototype, "discoverModels", async () => {
        switchGate.markEntered();
        await switchGate.promise;
        return [];
      });
      const ctx = { hasUI: true, ui: { setStatus: (_key: string, status?: string) => statuses.push(status) } } as unknown as ExtensionCommandContext;
      let doctorTask: Promise<void> | undefined;
      let switchTask: Promise<void> | undefined;

      if (scenario.first === "doctor") {
        doctorTask = commands.get("agy-bridge:doctor")!("", ctx);
        await doctorGate.entered;
        switchTask = commands.get("agy-bridge:driver")!("acp", ctx);
        await switchGate.entered;
        assert.deepEqual(statuses, ["Checking Antigravity CLI diagnostics…", "Switching to Antigravity ACP…"]);
      } else {
        switchTask = commands.get("agy-bridge:driver")!("acp", ctx);
        await switchGate.entered;
        doctorTask = commands.get("agy-bridge:doctor")!("", ctx);
        await doctorGate.entered;
        assert.deepEqual(statuses, ["Switching to Antigravity ACP…", "Checking Antigravity CLI diagnostics…"]);
      }

      if (scenario.releaseFirst === "doctor") {
        doctorGate.release();
        await doctorTask;
        assert.equal(statuses.at(-1), "Switching to Antigravity ACP…");
        switchGate.release();
        await switchTask;
      } else {
        switchGate.release();
        await switchTask;
        assert.equal(statuses.at(-1), "Checking Antigravity CLI diagnostics…");
        doctorGate.release();
        await doctorTask;
      }

      assert.equal(doctorUsage.mock.callCount(), 1);
      assert.equal(statuses.at(-1), undefined);
    });
  }
});

test("doctor progress is safe across context invalidation and shutdown", async (t) => {
  for (const scenario of [
    { name: "shutdown aborts pending doctor before invalidation", shutdown: true, replacement: true },
    { name: "isolated context invalidation retains captured UI", shutdown: false, replacement: false },
  ]) {
    await t.test(scenario.name, async (t) => {
      type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      const commands = new Map<string, Handler>();
      let shutdown!: () => Promise<void>;
      const sendMessage = t.mock.fn();
      const statuses = new Map<string, string | undefined>();
      const writes: Array<[string, string | undefined]> = [];
      const ui = { setStatus: (key: string, value?: string) => { writes.push([key, value]); statuses.set(key, value); } };
      const bridge = new Bridge({
        registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
        registerProvider: () => {},
        on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
        sendMessage,
      } as unknown as ExtensionAPI, new AcpDriver());
      let release!: () => void;
      let markEntered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      let pending: Promise<void> | undefined;
      t.after(async () => {
        release();
        await pending;
        if (shutdown) await shutdown();
      });
      t.mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
      t.mock.method(bridge.driver, "usage", async (signal: AbortSignal) => {
        assert.equal(signal.aborted, false);
        markEntered();
        await gate;
        return undefined;
      });
      t.mock.method(bridge.driver, "detectExecutable", () => undefined);
      bridge.start();
      let invalidated = false;
      const ctx = {
        get hasUI() { if (invalidated) throw new Error("context invalidated"); return true; },
        get ui() { if (invalidated) throw new Error("context invalidated"); return ui; },
      } as unknown as ExtensionCommandContext;

      pending = commands.get("agy-bridge:doctor")!("", ctx);
      await entered;
      assert.deepEqual(writes, [["agy-bridge", "Checking Antigravity ACP diagnostics…"]]);
      if (scenario.shutdown) await shutdown();
      invalidated = true;
      if (scenario.replacement) {
        statuses.set("agy-bridge", "New bridge operation");
      }
      const beforeLateCompletion = writes.length;
      release();
      await pending;

      assert.equal(sendMessage.mock.callCount(), scenario.shutdown ? 0 : 1);
      if (scenario.replacement) {
        assert.equal(statuses.get("agy-bridge"), "New bridge operation");
        assert.equal(writes.length, beforeLateCompletion, "shutdown cleanup must not overwrite replacement progress");
      } else {
        assert.equal(statuses.get("agy-bridge"), undefined);
        assert.equal(writes.length, beforeLateCompletion + 1, "cleanup uses the captured UI without reading stale context getters");
      }
    });
  }
});
