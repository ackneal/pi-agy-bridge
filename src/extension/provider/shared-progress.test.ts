import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { Bridge } from "./provider.ts";

useAuthHomeFixture();

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
