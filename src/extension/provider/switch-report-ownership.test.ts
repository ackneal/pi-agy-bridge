import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import { Bridge } from "./provider.ts";
import { AgyAuthentication } from "./auth.ts";

useAuthHomeFixture();

for (const scenario of [
  { outcome: "success", returnToCli: false },
  { outcome: "failure", returnToCli: false },
  { outcome: "success", returnToCli: true },
  { outcome: "failure", returnToCli: true },
] as const) {
  test(`late ${scenario.outcome} registry refresh cannot publish an obsolete report, return to CLI=${scenario.returnToCli}`, async (t) => {
    const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const messages: { customType: string; content: string }[] = [];
    const pi = {
      on: () => {}, sendMessage: (message: { customType: string; content: string }) => messages.push(message),
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => handlers.set(name, options.handler),
      registerProvider: () => {},
    } as unknown as ExtensionAPI;
    const detections = new WeakSet<object>();
    for (const Driver of [CliDriver, AcpDriver]) {
      t.mock.method(Driver.prototype, "detectExecutable", function (this: AcpDriver | CliDriver) {
        if (detections.has(this)) return undefined;
        detections.add(this);
        return "/mock/driver";
      });
      t.mock.method(Driver.prototype, "discoverModels", async () => []);
      t.mock.method(Driver.prototype, "usage", async () => undefined);
    }
    t.mock.method(AgyAuthentication.prototype, "detect", async () => undefined);
    const bridge = new Bridge(pi, new AcpDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    bridge.start();
    const command = handlers.get("agy-bridge:driver")!;
    let release!: (error?: Error) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve, reject) => { release = (error) => error ? reject(error) : resolve(); });
    let first = true;
    const modelRegistry = { refresh: async () => {
      if (first) { first = false; entered(); await gate; }
    } };
    const setStatus = t.mock.fn();
    const context = { hasUI: true, ui: { setStatus }, modelRegistry } as unknown as ExtensionCommandContext;
    let stale: Promise<void> | undefined;
    t.after(async () => { release(); await stale; });

    stale = command("cli", context);
    await waiting;
    await command("acp", context);
    if (scenario.returnToCli) await command("cli", context);
    const latestReports = messages.filter((message) => message.customType === "pi-agy-bridge:doctor");
    assert.equal(latestReports.length, scenario.returnToCli ? 2 : 1);
    assert.match(latestReports.at(-1)!.content, scenario.returnToCli ? /Antigravity CLI/ : /Antigravity ACP/);
    messages.length = 0;

    release(scenario.outcome === "failure" ? new Error("late registry failure") : undefined);
    await stale;
    assert.equal(messages.length, 0, "superseded completion must not publish diagnostics, warnings, or failures");
    assert.equal(bridge.driver.id, scenario.returnToCli ? "cli" : "acp");
    assert.deepEqual(setStatus.mock.calls.at(-1)?.arguments, ["agy-bridge", undefined]);
  });
}
