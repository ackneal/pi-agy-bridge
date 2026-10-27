import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { Bridge } from "./provider.ts";

for (const scenario of [
  { name: "refresh success", refreshFailure: false, discoveryFailure: false, doctorFailure: false },
  { name: "refresh rejection", refreshFailure: true, discoveryFailure: false, doctorFailure: false },
  { name: "discovery rejection", refreshFailure: false, discoveryFailure: true, doctorFailure: false },
  { name: "refresh rejection with doctor detection failure", refreshFailure: true, discoveryFailure: false, doctorFailure: true },
] as const) {
  test(`driver switch handles ${scenario.name}`, async (t) => {
    type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    let command!: Handler;
    const providers: Provider[] = [];
    const sendMessage = t.mock.fn();
    const setStatus = t.mock.fn();
    const bridge = new Bridge({
      on: () => {}, sendMessage,
      registerCommand: (name: string, options: { handler: Handler }) => {
        if (name === "agy-bridge:driver") command = options.handler;
      },
      registerProvider: (provider: Provider) => { providers.push(provider); },
    } as unknown as ExtensionAPI, new CliDriver());
    t.after(() => bridge.liveSessions.disposeAll());
    const catalog = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)");
    t.mock.method(AcpDriver.prototype, "discoverModels", async () => {
      if (scenario.discoveryFailure) throw new Error("synthetic discovery failure");
      return catalog.map((model) => ({ ...model, agyDriver: "acp" as const }));
    });
    t.mock.method(AcpDriver.prototype, "usage", async () => undefined);
    let detects = 0;
    t.mock.method(AcpDriver.prototype, "detectExecutable", () => {
      detects++;
      if (scenario.doctorFailure && detects > 1) throw new Error("synthetic diagnostics failure");
      return detects === 1 ? "/mock/acp" : undefined;
    });
    bridge.start();
    const refresh = t.mock.fn(async (_options: unknown) => {
      if (scenario.refreshFailure) throw new Error("synthetic registry failure");
    });
    const registry = { refresh } as unknown as ExtensionContext["modelRegistry"];

    await command("acp", { hasUI: true, ui: { setStatus }, modelRegistry: registry } as unknown as ExtensionCommandContext);

    assert.equal(refresh.mock.callCount(), scenario.discoveryFailure ? 0 : 1);
    assert.equal(providers.length, scenario.discoveryFailure ? 1 : 2);
    assert.equal(bridge.driver.id, scenario.discoveryFailure ? "cli" : "acp");
    if (!scenario.discoveryFailure) assert.equal(providers.at(-1)!.getModels()[0]?.id, "gemini-3.8-flash");
    assert.equal(sendMessage.mock.callCount(), 1);
    const [message] = sendMessage.mock.calls[0]!.arguments as unknown as [{ customType: string; content: string }];
    assert.equal(message.customType, scenario.discoveryFailure ? "pi-agy-bridge:driver" : "pi-agy-bridge:doctor");
    if (scenario.discoveryFailure) assert.match(message.content, /Failed to switch driver: synthetic discovery failure/);
    else {
      if (scenario.doctorFailure) assert.match(message.content, /^Failed to collect diagnostics: synthetic diagnostics failure/);
      else assert.match(message.content, /^agy-bridge doctor\n/);
      assert.doesNotMatch(message.content, /Failed to switch driver/);
      if (scenario.refreshFailure) assert.match(message.content, /Warning[\s\S]*Pi model registry refresh failed: synthetic registry failure/);
      else assert.doesNotMatch(message.content, /registry refresh failed/);
    }
    assert.deepEqual(setStatus.mock.calls.map((call) => call.arguments.at(-1)), [
      "Switching to Antigravity ACP…", undefined,
      ...(!scenario.discoveryFailure ? ["Checking Antigravity ACP diagnostics…", undefined] : []),
    ]);
  });
}
