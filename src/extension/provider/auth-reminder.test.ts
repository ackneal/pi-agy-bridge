import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type { BridgeDriver } from "../drivers/types.ts";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { registerAuthHomeFixture } from "./auth-home-fixture.ts";
import { Bridge } from "./provider.ts";

for (const action of ["expiry", "login success", "login failure", "driver switch", "session change", "shutdown", "overlapping doctor"] as const) {
  test(`temporary auth reminder: ${action}`, async (t) => {
    await registerAuthHomeFixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const handlers = new Map<string, (...args: any[]) => any>();
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const statuses: Array<string | undefined> = [];
    let provider!: Provider;
    let refreshed!: () => void;
    const ready = new Promise<void>((resolve) => { refreshed = resolve; });
    let usageEntered!: () => void;
    const entered = new Promise<void>((resolve) => { usageEntered = resolve; });
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
    const driver: BridgeDriver = {
      id: "cli", label: "Antigravity CLI", sessionVersion: "test:v1", initialModels: [],
      authentication: {
        label: "CLI", probe: async () => false,
        login: async () => { if (action === "login failure") throw new Error("fixture login failure"); },
      },
      validateSelection() {}, detectExecutable: () => undefined,
      discoverModels: async () => [],
      usage: async () => {
        if (action === "overlapping doctor") { usageEntered(); await usageGate; }
        return undefined;
      },
      prepareSession: async () => { throw new Error("Unexpected runtime preparation"); },
    };
    const notify = t.mock.fn();
    const sendMessage = t.mock.fn();
    const bridge = new Bridge({
      on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
      registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command.handler),
      registerProvider: (registered: Provider) => { provider = registered; },
      sendMessage,
    } as unknown as ExtensionAPI, driver);
    bridge.start();
    let doctor: Promise<void> | undefined;
    t.after(async () => { releaseUsage(); await doctor; await handlers.get("session_shutdown")!(); });
    const ctx = {
      hasUI: true,
      ui: { setStatus: (_key: string, message?: string) => statuses.push(message), notify },
      sessionManager: SessionManager.inMemory(), modelRegistry: { refresh: async () => { refreshed(); } },
    } as unknown as ExtensionCommandContext;

    handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    await ready;

    assert.equal(notify.mock.callCount(), 0);
    assert.equal(sendMessage.mock.callCount(), 0, "UI reminders must not leave a chat message");
    assert.match(statuses.at(-1)!, /not signed in.*\/login/);
    t.mock.timers.tick(7999);
    assert.match(statuses.at(-1)!, /not signed in/);

    if (action === "expiry") {
      t.mock.timers.tick(1);
    } else if (action === "login success" || action === "login failure") {
      const login = Promise.resolve(provider.auth.oauth!.login({
        signal: new AbortController().signal, notify: () => {},
        prompt: async () => { throw new Error("Unexpected login prompt"); },
      }));
      if (action === "login failure") {
        await assert.rejects(login, /fixture login failure/);
        assert.match(statuses.at(-1)!, /not signed in/);
        t.mock.timers.tick(1);
      } else await login;
    } else if (action === "driver switch") {
      t.mock.method(AcpDriver.prototype, "discoverModels", async () => []);
      await bridge.switchDriver("acp");
    } else if (action === "session change") {
      handlers.get("session_start")!({ type: "session_start", reason: "switch" }, ctx);
    } else if (action === "shutdown") {
      await handlers.get("session_shutdown")!();
    } else {
      doctor = commands.get("agy-bridge:doctor")!("", ctx);
      await entered;
      assert.match(statuses.at(-1)!, /Checking Antigravity CLI diagnostics/);
      t.mock.timers.tick(1);
      assert.match(statuses.at(-1)!, /Checking Antigravity CLI diagnostics/, "expiry must not clear newer progress");
      releaseUsage();
      await doctor;
    }

    assert.equal(statuses.at(-1), undefined);
    const count = statuses.length;
    t.mock.timers.tick(8000);
    assert.equal(statuses.length, count, "cancelled timers must not change later UI state");
  });
}
