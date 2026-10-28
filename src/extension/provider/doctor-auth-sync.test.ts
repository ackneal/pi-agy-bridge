import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import { AuthenticationRequiredError } from "../shared/types.ts";
import { createAgyBridgeCredential } from "./auth.ts";
import { Bridge } from "./provider.ts";
import { registerAuthHomeFixture } from "./auth-home-fixture.ts";

for (const driverId of ["cli", "acp"] as const) {
  for (const outcome of ["authenticated", "unauthenticated", "unknown"] as const) {
    test(`${driverId} doctor synchronizes ${outcome} without a second notification`, async (t) => {
      const directory = await registerAuthHomeFixture(t);
      const authPath = path.join(directory, "auth.json");
      const original = createAgyBridgeCredential("doctor-fixture", driverId);
      await writeFile(authPath, JSON.stringify({ agy: original }));
      const driver = driverId === "cli" ? new CliDriver() : new AcpDriver();
      t.mock.method(driver, "detectExecutable", () => undefined);
      const login = t.mock.method(driver.authentication, "login", async () => { throw new Error("must not log in"); });
      t.mock.method(driver.authentication, "probe", async () => {
        if (outcome === "unknown") throw new Error("fixture transport error");
        return outcome === "authenticated";
      });
      t.mock.method(driver, "usage", async () => {
        if (driverId === "acp") return undefined;
        if (outcome === "unauthenticated") throw new AuthenticationRequiredError();
        if (outcome === "unknown") throw new Error("fixture transport error");
        return { updatedAt: "2026-01-01T00:00:00Z", groups: [] };
      });
      let doctor!: (args: string, context: ExtensionContext) => Promise<void>;
      let shutdown!: () => Promise<void>;
      const sendMessage = t.mock.fn();
      const notify = t.mock.fn();
      const refresh = t.mock.fn(async () => {});
      const bridge = new Bridge({
        registerCommand: (name: string, command: { handler: typeof doctor }) => { if (name === "agy-bridge:doctor") doctor = command.handler; },
        registerProvider: () => {}, sendMessage,
        on: (name: string, handler: typeof shutdown) => { if (name === "session_shutdown") shutdown = handler; },
      } as unknown as ExtensionAPI, driver);
      bridge.start();
      t.after(() => shutdown());

      await doctor("", { hasUI: true, ui: { notify, setStatus: () => {} }, modelRegistry: { refresh } } as unknown as ExtensionContext);

      assert.equal(login.mock.callCount(), 0);
      assert.equal(notify.mock.callCount(), 0);
      assert.equal(sendMessage.mock.callCount(), 1);
      assert.match(sendMessage.mock.calls[0]!.arguments[0].content, new RegExp(`Auth: ${outcome}`));
      if (outcome === "unauthenticated") assert.match(sendMessage.mock.calls[0]!.arguments[0].content, /Run \/login and select Antigravity \[pi-agy-bridge\]/);
      assert.deepEqual(refresh.mock.calls[0]!.arguments, [{ providers: ["agy"], allowNetwork: false }]);
      const record = readStoredCredential("agy", authPath);
      if (outcome === "unauthenticated") assert.equal(record, undefined);
      else if (outcome === "unknown") assert.deepEqual(record, original);
      else {
        assert.equal(record?.type, "oauth");
        if (record?.type === "oauth") {
          assert.equal(record.driver, driverId);
          assert.equal(record.loginEpoch, original.loginEpoch);
        }
      }
    });
  }
}
