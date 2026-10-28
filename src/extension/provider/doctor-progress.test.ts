import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import { Bridge } from "./provider.ts";
import { AgyAuthentication } from "./auth.ts";

useAuthHomeFixture();

test("doctor command progress and reporting", async (t) => {
  for (const row of [
    { name: "success", hasUI: true, failure: false, shutdown: false, switch: false },
    { name: "diagnostic detection failure", hasUI: true, failure: true, shutdown: false, switch: false },
    { name: "shutdown while usage is pending", hasUI: true, failure: false, shutdown: true, switch: false },
    { name: "headless", hasUI: false, failure: false, shutdown: false, switch: false },
    { name: "post-switch diagnostics failure is not a switch failure", hasUI: true, failure: true, shutdown: false, switch: true },
  ]) {
    await t.test(row.name, async (t) => {
      type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      const commands = new Map<string, Handler>();
      let shutdown!: () => Promise<void>;
      const sendMessage = t.mock.fn();
      const setStatus = t.mock.fn();
      const bridge = new Bridge({
        registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
        registerProvider: () => {},
        on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
        sendMessage,
      } as unknown as ExtensionAPI, row.switch ? new CliDriver() : new AcpDriver());
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      let pending: Promise<void> | undefined;
      t.after(async () => {
        release();
        await pending;
        await shutdown();
      });
      t.mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
      const usage = t.mock.method(row.switch ? AcpDriver.prototype : bridge.driver, "usage", async (signal: AbortSignal) => {
        assert.equal(signal.aborted, false);
        entered();
        await gate;
        return undefined;
      });
      const detect = t.mock.method(row.switch ? AcpDriver.prototype : bridge.driver, "detectExecutable", () => {
        if (row.failure) throw new Error("synthetic diagnostics failure");
        return undefined;
      });
      if (row.switch) t.mock.method(AcpDriver.prototype, "discoverModels", async () => []);
      bridge.start();
      const ctx = { hasUI: row.hasUI, ui: { setStatus } } as unknown as ExtensionCommandContext;

      pending = commands.get(row.switch ? "agy-bridge:driver" : "agy-bridge:doctor")!(row.switch ? "acp" : "", ctx);
      await reached;

      const checking = ["agy-bridge", "Checking Antigravity ACP diagnostics…"];
      assert.deepEqual(setStatus.mock.calls.map((call) => call.arguments), row.hasUI
        ? row.switch ? [["agy-bridge", "Switching to Antigravity ACP…"], ["agy-bridge", undefined], checking] : [checking]
        : []);
      assert.equal(usage.mock.callCount(), 1);
      assert.equal(detect.mock.callCount(), 0);
      assert.equal(sendMessage.mock.callCount(), 0);
      if (row.shutdown) await shutdown();
      release();
      await pending;

      assert.deepEqual(setStatus.mock.calls.at(-1)?.arguments, row.hasUI ? ["agy-bridge", undefined] : undefined);
      assert.equal(setStatus.mock.callCount(), row.hasUI ? row.switch ? 4 : 2 : 0);
      assert.equal(detect.mock.callCount(), row.shutdown ? 0 : 1);
      if (row.switch) assert.equal(bridge.driver.id, "acp");
      assert.equal(sendMessage.mock.callCount(), row.shutdown ? 0 : 1);
      if (!row.shutdown) {
        const [message, options] = sendMessage.mock.calls.at(-1)!.arguments as unknown as [{ customType: string; content: string; display: boolean }, unknown];
        assert.equal(message.customType, "pi-agy-bridge:doctor");
        assert.equal(message.display, true);
        assert.deepEqual(options, { triggerTurn: false });
        if (row.failure) assert.equal(message.content, "Failed to collect diagnostics: synthetic diagnostics failure");
        else assert.match(message.content, /^agy-bridge doctor\n/);
      }
    });
  }
});
