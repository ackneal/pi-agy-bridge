import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { Bridge } from "./provider.ts";

useAuthHomeFixture();

for (const row of [
  { name: "authenticated probe", result: true, expected: /Auth: authenticated/ },
  { name: "unauthenticated probe", result: false, expected: /Auth: unauthenticated/ },
  { name: "failed probe", result: new Error("network timeout"), expected: /Auth: unknown/ },
] as const) {
  test(`ACP doctor reports ${row.name} without logging in`, async (t) => {
    let doctor!: () => Promise<void>;
    const messages: string[] = [];
    const driver = new AcpDriver();
    const login = t.mock.method(driver.authentication, "login", async () => {
      throw new Error("login must not run");
    });
    const probe = t.mock.method(driver.authentication, "probe", async () => {
      if (row.result instanceof Error) throw row.result;
      return row.result;
    });
    const pi = {
      registerCommand: (name: string, command: { handler: () => Promise<void> }) => {
        if (name === "agy-bridge:doctor") doctor = command.handler;
      },
      registerProvider: () => {}, on: () => {},
      sendMessage: (message: { content: string }) => {
        messages.push(message.content);
      },
    } as unknown as ExtensionAPI;
    t.mock.method(driver, "detectExecutable", () => undefined);
    const bridge = new Bridge(pi, driver);
    bridge.start();
    assert.ok(doctor);
    await doctor();
    const report = messages.join("\n");
    assert.match(report, row.expected);
    if (row.result instanceof Error) assert.match(report, /authentication error|network timeout/i);
    assert.equal(probe.mock.callCount(), 1);
    assert.equal(login.mock.callCount(), 0);
  });
}
