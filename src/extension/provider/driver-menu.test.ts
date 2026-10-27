import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import { Bridge } from "./provider.ts";

type Scenario = {
  name: string;
  current?: "cli";
  args?: string;
  hasUI?: false;
  selected?: string;
  target?: "acp" | "cli";
  outcome: "doctorFailure" | "success" | "failure" | "same" | "cancel" | "status" | "invalid";
};

const scenarios: Scenario[] = [
  { name: "default ACP menu switches to CLI", selected: "CLI", target: "cli", outcome: "success" },
  { name: "CLI menu switches to ACP", current: "cli", selected: "ACP", target: "acp", outcome: "success" },
  { name: "current ACP selection does not switch", selected: "ACP (current)", outcome: "same" },
  { name: "current CLI selection does not switch", current: "cli", selected: "CLI (current)", outcome: "same" },
  { name: "cancelled menu has no side effects", outcome: "cancel" },
  { name: "doctor failure does not undo successful switch", selected: "CLI", target: "cli", outcome: "doctorFailure" },
  { name: "CLI switch failure is reported", selected: "CLI", target: "cli", outcome: "failure" },
  { name: "explicit CLI bypasses menu", args: " CLI ", target: "cli", outcome: "success" },
  { name: "explicit ACP bypasses menu", current: "cli", args: "acp", target: "acp", outcome: "success" },
  { name: "explicit current driver bypasses menu", args: "acp", outcome: "same" },
  { name: "explicit invalid driver bypasses menu", args: "other", outcome: "invalid" },
  { name: "headless default ACP reports status", hasUI: false, outcome: "status" },
  { name: "headless CLI reports status", current: "cli", hasUI: false, outcome: "status" },
];

for (const scenario of scenarios) {
  test(`driver command: ${scenario.name}`, async (t) => {
    let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const sendMessage = t.mock.fn();
    const registerProvider = t.mock.fn();
    const pi = {
      on: () => {}, sendMessage, registerProvider,
      registerCommand: (name: string, options: { handler: typeof command }) => {
        if (name === "agy-bridge:driver") command = options.handler;
      },
    } as unknown as ExtensionAPI;
    const acpDetection = t.mock.method(AcpDriver.prototype, "detectExecutable", () => scenario.outcome === "status" ? "/mock/acp" : undefined);
    const cliDetection = t.mock.method(CliDriver.prototype, "detectExecutable", () => {
      if (scenario.outcome === "doctorFailure") throw new Error("synthetic diagnostics failure");
      return undefined;
    });
    const bridge = scenario.current === "cli" ? new Bridge(pi, new CliDriver()) : new Bridge(pi);
    t.after(() => bridge.liveSessions.disposeAll());
    const acpUsage = t.mock.method(AcpDriver.prototype, "usage", async () => undefined);
    const cliUsage = t.mock.method(CliDriver.prototype, "usage", async () => undefined);
    bridge.start();
    const registrations = registerProvider.mock.callCount();
    const label = bridge.driver.label;
    const current = bridge.driver.id;
    const switchDriver = t.mock.method(bridge, "switchDriver", async (target: "acp" | "cli") => {
      if (scenario.outcome === "failure") throw new Error("synthetic switch failure");
      bridge.driver = target === "cli" ? new CliDriver() : new AcpDriver();
    });
    const select = t.mock.fn(async () => scenario.selected);
    const modelRegistry = {} as ExtensionCommandContext["modelRegistry"];
    const setStatus = t.mock.fn();
    const ctx = {
      hasUI: scenario.hasUI !== false, ui: { select, setStatus }, modelRegistry,
    } as unknown as ExtensionCommandContext;

    await command(scenario.args ?? "", ctx);

    const menu = !scenario.args && ctx.hasUI;
    assert.equal(select.mock.callCount(), menu ? 1 : 0);
    if (menu) {
      assert.deepEqual(select.mock.calls[0]!.arguments, [
        "Select Antigravity driver",
        current === "acp" ? ["ACP (current)", "CLI"] : ["ACP", "CLI (current)"],
      ]);
    }
    assert.equal(switchDriver.mock.callCount(), scenario.target ? 1 : 0);
    if (scenario.target) assert.deepEqual(switchDriver.mock.calls[0]!.arguments, [scenario.target, modelRegistry]);
    assert.equal(registerProvider.mock.callCount(), registrations);
    const succeeded = scenario.outcome === "success" || scenario.outcome === "doctorFailure";
    const targetLabel = scenario.target === "cli" ? "Antigravity CLI" : "Antigravity ACP";
    assert.equal(acpUsage.mock.callCount(), succeeded && scenario.target === "acp" ? 1 : 0);
    assert.equal(cliUsage.mock.callCount(), succeeded && scenario.target === "cli" ? 1 : 0);
    assert.equal(acpDetection.mock.callCount(), scenario.outcome === "status" || (succeeded && scenario.target === "acp") ? 1 : 0);
    assert.equal(cliDetection.mock.callCount(), scenario.outcome === "status" || (succeeded && scenario.target === "cli") ? 1 : 0);
    assert.deepEqual(setStatus.mock.calls.map(call => call.arguments), [
      ...(scenario.target ? [["agy-bridge", `Switching to ${targetLabel}…`], ["agy-bridge", undefined]] : []),
      ...(succeeded ? [["agy-bridge", `Checking ${targetLabel} diagnostics…`], ["agy-bridge", undefined]] : []),
    ]);

    if (scenario.outcome === "cancel") {
      assert.equal(sendMessage.mock.callCount(), 0);
      return;
    }
    const contents = {
      failure: "Failed to switch driver: synthetic switch failure",
      same: `Already using driver: **${label}** (${current}).`,
      invalid: 'Unknown driver "other". Available: cli, acp.',
      status: [
        `Current driver: **${label}** (${current})`,
        "Default: ACP. Driver changes are explicit; automatic fallback is disabled.",
        "", "Available drivers:", "- **acp**: ✓ Found (/mock/acp)", "- **cli**: ✗ Not found", "",
        "Usage: `/agy-bridge:driver cli` or `/agy-bridge:driver acp`",
      ].join("\n"),
    };
    assert.equal(sendMessage.mock.callCount(), 1);
    if (scenario.outcome === "success" || scenario.outcome === "doctorFailure") {
      assert.equal(bridge.driver.id, scenario.target);
      const [report, options] = sendMessage.mock.calls[0]!.arguments;
      assert.equal(report.customType, "pi-agy-bridge:doctor");
      assert.equal(report.display, true);
      assert.deepEqual(options, { triggerTurn: false });
      if (scenario.outcome === "doctorFailure") {
        assert.equal(report.content, "Failed to collect diagnostics: synthetic diagnostics failure");
      } else {
        assert.match(report.content, /^agy-bridge doctor\n/);
        assert.ok(report.content.includes(targetLabel));
      }
    } else {
      assert.deepEqual(sendMessage.mock.calls[0]!.arguments, [
        { customType: "pi-agy-bridge:driver", content: contents[scenario.outcome], display: true },
        { triggerTurn: false },
      ]);
    }
  });
}
