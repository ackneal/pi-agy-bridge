import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { useExecutable } from "../drivers/acp/executable-fixture.ts";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/ipc.ts";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { RuntimeSession as AcpRuntimeSession } from "../drivers/acp/runtime.ts";
import { Session as AcpSession } from "../drivers/acp/session.ts";
import { composeSystemPrompt, fingerprintSystemPrompt } from "../drivers/acp/instructions.ts";
import { Bridge, streamProvider } from "./provider.ts";
import { prepareSystemMessages } from "./context-prompt.ts";

let home: string;
let previousHome: string | undefined;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "agy-native-home-"));
  previousHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.GEMINI_HOME;
  else process.env.GEMINI_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const model: Model<"agy"> = {
  id: "selected", name: "Synthetic", api: "agy", provider: "agy", baseUrl: "agy",
  reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

for (const scenario of ["unchanged sections", "changed section", "removed section", "unchanged legacy", "changed legacy"] as const) {
  test(`ACP instructions at provider boundary: ${scenario}`, { timeout: 10000 }, async (t) => {
    const legacy = scenario.includes("legacy");
    const changed = !scenario.startsWith("unchanged");
    const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
    const directory = await mkdtemp(path.join(tmpdir(), "agy-acp-provider-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "acp");
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url))}"\n`, { mode: 0o755 });
    useExecutable(t, executable);
    const bridge = new Bridge(pi);
    const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(tmpdir()));
    const session = bridge.liveSessions.getOrCreate(sessionId);
    const tools = [{ name: "read", description: "Synthetic read", parameters: { type: "object", properties: {} } }];
    const gateway = new CapabilityGateway(tools, session.resources);
    t.after(async () => {
      gateway.cancelPendingCalls("cleanup");
      await bridge.liveSessions.disposeAll();
      t.mock.restoreAll();
    });
    t.mock.method(bridge, "getTools", () => tools);
    t.mock.method(BridgeIPC.prototype, "start", async () => {});
    t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock");
    t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => gateway.hasPendingCalls);
    t.mock.method(BridgeIPC.prototype, "setToolCallHandler", (handler: Parameters<BridgeIPC["setToolCallHandler"]>[0]) => gateway.setToolCallHandler(handler));
    const resolve = t.mock.method(BridgeIPC.prototype, "resolveToolResults", (messages: Context["messages"], appendix?: string) => gateway.resolveToolResults(messages, appendix));
    t.mock.method(BridgeIPC.prototype, "close", async () => { gateway.cancelPendingCalls("closed"); });
    const prompts: Parameters<AcpSession["prompt"]>[0][] = [];
    let oldResult: unknown;
    t.mock.method(AcpSession.prototype, "prompt", function (content: Parameters<AcpSession["prompt"]>[0]): ReturnType<AcpSession["prompt"]> {
      prompts.push(content);
      if (prompts.length > 1) return Promise.resolve({ stopReason: "end_turn" });
      return gateway.call("read", { path: "synthetic.txt" }).then((result) => {
        oldResult = result;
        return { stopReason: "end_turn" };
      });
    });
    const collect = async (context: Context) => {
      const events: AssistantMessageEvent[] = [];
      for await (const event of streamProvider(model, context, { sessionId }, bridge)) events.push(event);
      const last = events.at(-1);
      assert.ok(last?.type === "done", JSON.stringify(last));
      return last;
    };
    const context: Context = {
      tools,
      ...(legacy ? { systemPrompt: "PRIVATE_BASE\n\nPRIVATE_SECTION" } : {}),
      messages: [
        ...(!legacy ? [{ role: "system" as const, content: "PRIVATE_BASE", sections: { policy: "PRIVATE_SECTION" }, timestamp: 0 }] : []),
        { role: "user", content: "Read synthetic.txt", timestamp: 1 },
      ],
    };
    const first = await collect(context);
    assert.equal(first.reason, "toolUse");
    const runtime = session.activeProcess;
    assert.ok(runtime instanceof AcpRuntimeSession);
    assert.equal(runtime.options.systemPrompt, composeSystemPrompt(prepareSystemMessages(context)));
    assert.ok(runtime.options.systemPrompt?.includes("PRIVATE_SECTION"));
    assert.equal(runtime.compatibilityKey, fingerprintSystemPrompt(JSON.stringify([path.join(process.env.GEMINI_HOME!, "antigravity-acp"), composeSystemPrompt(prepareSystemMessages(context))])));
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.compatibilityKey, runtime.compatibilityKey);
    assert.ok(!JSON.stringify(prompts[0]).includes("PRIVATE_"));
    assert.ok(gateway.hasPendingCalls);
    const call = first.message.content.find((part) => part.type === "toolCall");
    assert.ok(call?.type === "toolCall");
    const result = { role: "toolResult" as const, toolCallId: call.id, toolName: "read", content: [{ type: "text" as const, text: "HISTORICAL_COMPLETED_RESULT" }], isError: false, timestamp: 3 };
    const next: Context = {
      ...context,
      ...(legacy && changed ? { systemPrompt: "PRIVATE_CHANGED" } : {}),
      messages: [...context.messages, first.message, result,
        ...(!legacy && changed ? [{ role: "system" as const, content: "", sections: { policy: scenario === "removed section" ? null : "PRIVATE_CHANGED" }, timestamp: 4 }] : []),
      ],
    };
    const second = await collect(next);
    assert.equal(second.reason, "stop");
    const active = session.activeProcess;
    assert.ok(active instanceof AcpRuntimeSession);
    assert.equal(active.options.systemPrompt, composeSystemPrompt(prepareSystemMessages(next)));
    assert.equal((await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion))?.compatibilityKey, fingerprintSystemPrompt(JSON.stringify([path.join(process.env.GEMINI_HOME!, "antigravity-acp"), composeSystemPrompt(prepareSystemMessages(next))])));
    if (changed) {
      assert.notEqual(active, runtime);
      assert.equal(resolve.mock.callCount(), 0);
      assert.equal(prompts.length, 2);
      const replay = JSON.stringify(prompts[1]);
      assert.ok(replay.includes("synthetic.txt"));
      assert.ok(!replay.includes("HISTORICAL_COMPLETED_RESULT"));
      assert.ok(!replay.includes("PRIVATE_"));
      assert.ok(!JSON.stringify(oldResult).includes("HISTORICAL_COMPLETED_RESULT"));
      if (scenario === "removed section") assert.ok(!active.options.systemPrompt?.includes("PRIVATE_SECTION"));
    } else {
      assert.equal(active, runtime);
      assert.equal(resolve.mock.callCount(), 1);
      assert.equal(prompts.length, 1);
      assert.ok(JSON.stringify(oldResult).includes("HISTORICAL_COMPLETED_RESULT"));
    }
    assert.equal(gateway.hasPendingCalls, false);
  });
}
