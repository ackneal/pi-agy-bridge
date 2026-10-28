import { beforeEach } from "node:test";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import { Bridge } from "./provider.ts";

useAuthHomeFixture();

test("overlapping commands preserve the newest active footer operation", async (t) => {
  for (const scenario of [
    { name: "doctor finishes before switch discovery", first: "doctor", releaseFirst: "doctor" },
    { name: "older doctor finishes after switch discovery", first: "doctor", releaseFirst: "switch" },
    { name: "newer doctor restores pending switch progress", first: "switch", releaseFirst: "doctor" },
  ] as const) {
    await t.test(scenario.name, async (t) => {
      type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      const commands = new Map<string, Handler>();
      const statuses: Array<string | undefined> = [];
      const gates = new Map<string, { promise: Promise<void>; release: () => void; entered: Promise<void>; markEntered: () => void }>();
      for (const name of ["doctor", "switch"]) {
        let release!: () => void;
        let markEntered!: () => void;
        const promise = new Promise<void>((resolve) => { release = resolve; });
        const entered = new Promise<void>((resolve) => { markEntered = resolve; });
        gates.set(name, { promise, release, entered, markEntered });
      }
      const bridge = new Bridge({
        registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
        registerProvider: () => {}, on: () => {}, sendMessage: () => {},
      } as unknown as ExtensionAPI, new CliDriver());
      t.after(async () => {
        gates.forEach((gate) => gate.release());
        await Promise.allSettled([doctorTask, switchTask].filter((task): task is Promise<void> => task !== undefined));
        await bridge.liveSessions.disposeAll();
      });
      bridge.start();
      const doctorGate = gates.get("doctor")!;
      const switchGate = gates.get("switch")!;
      const doctorUsage = t.mock.method(bridge.driver, "usage", async () => {
        doctorGate.markEntered();
        await doctorGate.promise;
        return undefined;
      });
      t.mock.method(bridge.driver, "detectExecutable", () => undefined);
      let detections = 0;
      t.mock.method(AcpDriver.prototype, "detectExecutable", () => ++detections === 1 ? "/unused/acp" : undefined);
      t.mock.method(AcpDriver.prototype, "discoverModels", async () => {
        switchGate.markEntered();
        await switchGate.promise;
        return [];
      });
      const ctx = { hasUI: true, ui: { setStatus: (_key: string, status?: string) => statuses.push(status) } } as unknown as ExtensionCommandContext;
      let doctorTask: Promise<void> | undefined;
      let switchTask: Promise<void> | undefined;

      if (scenario.first === "doctor") {
        doctorTask = commands.get("agy-bridge:doctor")!("", ctx);
        await doctorGate.entered;
        switchTask = commands.get("agy-bridge:driver")!("acp", ctx);
        await switchGate.entered;
        assert.deepEqual(statuses, ["Checking Antigravity CLI diagnostics…", "Switching to Antigravity ACP…"]);
      } else {
        switchTask = commands.get("agy-bridge:driver")!("acp", ctx);
        await switchGate.entered;
        doctorTask = commands.get("agy-bridge:doctor")!("", ctx);
        await doctorGate.entered;
        assert.deepEqual(statuses, ["Switching to Antigravity ACP…", "Checking Antigravity CLI diagnostics…"]);
      }

      if (scenario.releaseFirst === "doctor") {
        doctorGate.release();
        await doctorTask;
        assert.equal(statuses.at(-1), "Switching to Antigravity ACP…");
        switchGate.release();
        await switchTask;
      } else {
        switchGate.release();
        await switchTask;
        assert.equal(statuses.at(-1), "Checking Antigravity CLI diagnostics…");
        doctorGate.release();
        await doctorTask;
      }

      assert.equal(doctorUsage.mock.callCount(), 1);
      assert.equal(statuses.at(-1), undefined);
    });
  }
});
