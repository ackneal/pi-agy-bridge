import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { Bridge } from "./provider.ts";
import { AgyAuthentication } from "./auth.ts";

useAuthHomeFixture();

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
