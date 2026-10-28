import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { Bridge } from "./provider.ts";

useAuthHomeFixture();

test("ACP installation shares doctor status and restores diagnostics after installation", async (t) => {
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
    for (const phase of ["download", "verify", "complete"] as const) {
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

  assert.ok(statuses.length > 0);
  assert.ok(statuses.every(([key]) => key === "agy-bridge"));
  const verify = statuses.findIndex(([, message]) => message === "verify");
  assert.ok(verify >= 0);
  assert.deepEqual(statuses[verify + 1], ["agy-bridge", "Checking Antigravity ACP diagnostics…"]);
  assert.deepEqual(statuses.at(-1), ["agy-bridge", undefined]);
});
