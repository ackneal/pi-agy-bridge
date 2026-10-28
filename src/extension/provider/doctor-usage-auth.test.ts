import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CliDriver } from "../drivers/cli/driver.ts";
import { AgyAuthenticationRequiredError, type AgyUsage } from "../runtime/usage.ts";
import { Bridge } from "./provider.ts";

useAuthHomeFixture();

const quota: AgyUsage = {
  updatedAt: "2026-01-01T00:00:00Z",
  groups: [{ name: "Fixture", buckets: [{ id: "fixture", name: "Weekly", window: "weekly", remainingFraction: 0.5 }] }],
};

for (const row of [
  { outcome: "success", status: "authenticated", hasQuota: true },
  { outcome: "required", status: "unauthenticated", hasQuota: false },
  { outcome: "network failure", status: "unknown", hasQuota: false },
] as const) {
  test(`CLI doctor refreshes previously authenticated status after ${row.outcome}`, async (t) => {
    let doctor!: () => Promise<void>;
    let shutdown!: () => Promise<void>;
    let provider!: Provider;
    const sendMessage = t.mock.fn();
    const driver = new CliDriver();
    t.mock.method(driver, "detectExecutable", () => undefined);
    const login = t.mock.method(driver.authentication, "login", async () => {});
    const usage = t.mock.method(driver, "usage", async () => {
      if (row.outcome === "required") throw new AgyAuthenticationRequiredError();
      if (row.outcome === "network failure") throw new Error("synthetic network failure");
      return quota;
    });
    const bridge = new Bridge({
      registerCommand: (name: string, command: { handler: () => Promise<void> }) => {
        if (name === "agy-bridge:doctor") doctor = command.handler;
      },
      registerProvider: (registered: Provider) => { provider = registered; },
      on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
      sendMessage,
    } as unknown as ExtensionAPI, driver);
    bridge.start();
    t.after(() => shutdown());
    await provider.auth!.oauth!.login({
      signal: new AbortController().signal,
      notify: () => {},
      prompt: async () => { throw new Error("Fixture login must not prompt"); },
    });

    await doctor();

    assert.equal(login.mock.callCount(), 1, "doctor must not start a new login");
    assert.equal(usage.mock.callCount(), 1);
    assert.equal(sendMessage.mock.callCount(), 1);
    const [message] = sendMessage.mock.calls[0]!.arguments;
    assert.equal(message.customType, "pi-agy-bridge:doctor");
    assert.ok(message.content.includes(`Auth: ${row.status}`));
    assert.equal(message.content.includes("Quota remaining"), row.hasQuota);
    if (row.outcome !== "success") assert.match(message.content, /! usage /);
    if (row.outcome === "network failure") assert.match(message.content, /synthetic network failure/);
  });
}
