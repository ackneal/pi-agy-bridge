import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ModelRuntime, readStoredCredential, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { createAgyBridgeCredential } from "./auth.ts";
import { Bridge } from "./provider.ts";
import { registerAuthHomeFixture } from "./auth-home-fixture.ts";

for (const driverId of ["cli", "acp"] as const) {
  for (const outcome of ["success", "required", "error"] as const) {
    for (const saved of ["absent", "matching", "other driver"] as const) {
      test(`${driverId} startup ${outcome} with ${saved} credential`, async (t) => {
        const directory = await registerAuthHomeFixture(t);
        const authPath = path.join(directory, "auth.json");
        const original = saved === "absent" ? undefined : { ...createAgyBridgeCredential(), driver: saved === "matching" ? driverId : driverId === "cli" ? "acp" : "cli" };
        if (original) await writeFile(authPath, JSON.stringify({ agy: original }));
        let start!: (event: SessionStartEvent, context: ExtensionContext) => void;
        let shutdown!: () => Promise<void>;
        const driver = driverId === "cli" ? new CliDriver() : new AcpDriver();
        const probe = t.mock.method(driver.authentication, "probe", async () => {
          if (outcome === "error") throw new Error("fixture connection failure");
          return outcome === "success";
        });
        const login = t.mock.method(driver.authentication, "login", async () => { throw new Error("must not log in"); });
        const sendMessage = t.mock.fn();
        const notify = t.mock.fn();
        const setStatus = t.mock.fn();
        const pi = {
          on: (event: string, handler: unknown) => {
            if (event === "session_start") start = handler as typeof start;
            if (event === "session_shutdown") shutdown = handler as typeof shutdown;
          },
          registerCommand: () => {}, registerProvider: () => {}, sendMessage,
        } as unknown as ExtensionAPI;
        const bridge = new Bridge(pi, driver);
        let refreshed!: () => void;
        const completed = new Promise<void>((resolve) => { refreshed = resolve; });
        const refresh = t.mock.fn(async () => { refreshed(); });
        const hasUI = saved === "matching";
        const context = { hasUI, ui: { notify, setStatus }, sessionManager: { getSessionId: () => "fixture" }, modelRegistry: { refresh } } as unknown as ExtensionContext;
        bridge.start();
        t.after(() => shutdown());

        const piLogin = t.mock.method(ModelRuntime.prototype, "login");
        const piLogout = t.mock.method(ModelRuntime.prototype, "logout");
        assert.equal(start({ type: "session_start", reason: "startup" }, context), undefined);
        await completed;

        assert.equal(probe.mock.callCount(), 1);
        assert.equal(login.mock.callCount(), 0);
        assert.equal(refresh.mock.callCount(), 1);
        const record = readStoredCredential("agy", authPath);
        if (outcome === "success") {
          assert.equal(record?.type, "oauth");
          if (record?.type === "oauth") assert.equal(record.driver, driverId);
        } else if (outcome === "required") assert.equal(record, undefined);
        else assert.deepEqual(record, original);
        assert.equal(sendMessage.mock.callCount(), outcome === "required" && !hasUI ? 1 : 0);
        assert.equal(notify.mock.callCount(), 0);
        assert.equal(setStatus.mock.callCount(), outcome === "required" && hasUI ? 1 : 0);
        if (outcome === "required") {
          const message = hasUI ? setStatus.mock.calls[0]!.arguments[1] : sendMessage.mock.calls[0]!.arguments[0].content;
          assert.match(message, /\/login.*Antigravity \[pi-agy-bridge\]/);
        }

        start({ type: "session_start", reason: "startup" }, context);
        start({ type: "session_start", reason: "reload" }, context);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(probe.mock.callCount(), 1);
        assert.equal(piLogin.mock.callCount(), outcome === "success" && saved !== "matching" ? 1 : 0);
        assert.equal(piLogout.mock.callCount(), outcome === "required" && saved !== "absent" ? 1 : 0);
        assert.equal(sendMessage.mock.callCount(), outcome === "required" && !hasUI ? 1 : 0);
        assert.equal(notify.mock.callCount(), 0);
        if (outcome === "required" && hasUI) assert.deepEqual(setStatus.mock.calls.at(-1)?.arguments, ["agy-bridge", undefined]);
      });
    }
  }
}
