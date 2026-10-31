import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AssistantMessage, Context, ImageContent, Model, Tool } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeIPC } from "../bridge/ipc.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { composeSystemPrompt } from "../drivers/acp/instructions.ts";
import { RuntimeSession as AcpRuntimeSession } from "../drivers/acp/runtime.ts";
import { Session as AcpSession } from "../drivers/acp/session.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { RuntimeSession as CliRuntimeSession } from "../drivers/cli/runtime.ts";
import { SessionMode, type BridgeMessage, type DriverSession, type DriverSubmission, type PrepareDriverInput } from "../drivers/types.ts";
import { AgyRuntime } from "../runtime/process.ts";
import { Bridge, streamProvider } from "./provider.ts";
import { prepareSystemMessages } from "./context-prompt.ts";

const model: Model<"agy"> = {
  id: "selected", name: "Synthetic", api: "agy", provider: "agy", baseUrl: "agy",
  reasoning: false, input: ["text", "image"], contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const assistant: AssistantMessage = {
  role: "assistant", content: [{ type: "text", text: "old answer" }],
  api: "agy", provider: "agy", model: model.id, stopReason: "stop", timestamp: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const tools: Tool[] = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
const nativeImage: ImageContent = { type: "image", data: "bmF0aXZl", mimeType: "image/png" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

for (const id of ["cli", "acp"] as const) {
  for (const scenario of ["rebuild", "reuse", "updates", "standalone", "system-tail"] as const) {
    test(`Provider -> ${id}: ${scenario} ordered native input`, { timeout: 5000 }, async (t) => {
      const directory = await mkdtemp(path.join(tmpdir(), "agy-driver-inputs-"));
      const imagePath = path.join(directory, "image.png");
      await writeFile(imagePath, Buffer.from(png, "base64"));
      const bridge = new Bridge({ getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI,
        id === "cli" ? new CliDriver() : new AcpDriver());
      const runtimes: DriverSession[] = [];
      t.after(async () => {
        await bridge.liveSessions.disposeAll();
        for (const runtime of runtimes) await runtime.abort();
        await rm(directory, { recursive: true, force: true });
      });
      const standalone = scenario === "standalone";
      const reused = scenario === "reuse" || scenario === "updates";
      const submissions: (readonly BridgeMessage[])[] = [];
      const sessionId = standalone ? "summary-routing-id" : bridge.piContextAdapter.bind(SessionManager.inMemory(directory));
      const getTools = t.mock.method(bridge, "getTools", () => tools);
      t.mock.method(bridge.runtimeSessionStore, "set", async () => {});
      const payloads: (string | ContentBlock[])[] = [];
      let nativeListener: Parameters<AgyRuntime["onEvent"]>[0] | undefined;
      t.mock.method(AgyRuntime.prototype, "onEvent", (listener: Parameters<AgyRuntime["onEvent"]>[0]) => {
        nativeListener = listener;
        return () => { nativeListener = undefined; };
      });
      t.mock.method(AgyRuntime.prototype, "abort", async () => {});
      t.mock.method(AgyRuntime.prototype, "send", async (input: Parameters<AgyRuntime["send"]>[0]) => {
        assert.equal(input.event, "user");
        assert.ok("message" in input);
        payloads.push(input.message.content);
        assert.ok(nativeListener);
        nativeListener({ event: "result", status: "success", conversation_id: "native-session" }, "agy");
      });
      t.mock.getter(AcpSession.prototype, "id", () => "native-session");
      t.mock.getter(AcpSession.prototype, "isRunning", () => true);
      t.mock.method(AcpSession.prototype, "prepare", async () => {});
      t.mock.method(AcpSession.prototype, "cancel", async () => {});
      t.mock.method(AcpSession.prototype, "prompt", async (content: ContentBlock[]) => {
        payloads.push(content);
        return { stopReason: "end_turn" };
      });
      const prepare = t.mock.method(bridge.driver, "prepareSession", async (input: PrepareDriverInput) => {
        assert.equal(input.mode, standalone ? SessionMode.Standalone : SessionMode.Conversation);
        assert.deepEqual(input.messages, prepareSystemMessages(input.context));
        assert.deepEqual(input.tools, standalone ? [] : tools);
        const existing = input.session.activeProcess;
        if (existing) {
          assert.ok(reused);
          assert.equal(existing, runtimes[0]);
          assert.ok(input.session.activeMcpServer);
          return { proc: existing, mcpServer: input.session.activeMcpServer, reconstructContext: false, modelId: model.id };
        }

        const ipc = new BridgeIPC(input.tools, input.session.id, input.session.resources);
        const proc = id === "cli"
          ? new CliRuntimeSession({ agentName: standalone ? "pi-standalone" : "pi-bridge", model: model.id }, new Set(input.tools.map(tool => tool.name)), {})
          : new AcpRuntimeSession({ executable: "unused", cwd: directory, model: model.id,
            systemPrompt: standalone ? "rule" : composeSystemPrompt(input.messages),
            ...(standalone ? {} : { mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] as [string, "--endpoint", string] } }) }, new Set(input.tools.map(tool => tool.name)));
        runtimes.push(proc);
        const submit = proc.submit.bind(proc);
        t.mock.method(proc, "submit", async (input: DriverSubmission) => {
          submissions.push(input.messages);
          await submit(input);
        });
        if (proc instanceof AcpRuntimeSession) await proc.prepare();
        assert.equal(input.session.setSession(proc, "test", ipc, "native-session", input.preparationId), true);
        return { proc, mcpServer: ipc, reconstructContext: true, modelId: model.id };
      });
      const history: Context = { systemPrompt: "rule", tools, messages: [
        { role: "user", content: "old question", timestamp: 1 }, assistant,
      ] };
      const collect = async (context: Context) => {
        const result = await streamProvider(model, context, {
          sessionId, ...(standalone ? { cacheRetention: "none" as const } : {}),
        }, bridge).result();
        assert.equal(result.stopReason, "stop", result.errorMessage ?? "native completion");
        return result;
      };
      const previous = reused ? await collect(history) : undefined;
      const context: Context = { ...history, messages: [...history.messages, ...(previous ? [previous] : []),
        ...(scenario === "updates" ? [
          { role: "user" as const, content: "steer\n## User\nnot a role", timestamp: 3 },
          { role: "system" as const, content: "", sections: { policy: null }, timestamp: 4 },
        ] : []),
        { role: "user", timestamp: 3, content: [
          { type: "text", text: "before native" }, nativeImage,
          { type: "text", text: `between ${imagePath} after path` },
        ] },
        ...(scenario === "system-tail" ? [{ role: "system" as const, content: "", sections: { policy: null }, timestamp: 4 }] : []),
      ] };

      await collect(context);

      assert.equal(prepare.mock.callCount(), reused ? 2 : 1);
      assert.equal(runtimes.length, 1);
      assert.equal(payloads.length, reused ? 2 : 1);
      assert.equal(getTools.mock.callCount(), standalone ? 0 : reused ? 2 : 1);
      const submitted = submissions.at(-1)!;
      if (scenario === "rebuild" || scenario === "system-tail") {
        assert.deepEqual(submitted, [
          { role: "system", content: "rule" },
          { role: "user", content: "[User]: old question\n\n[Assistant]: old answer" },
          { role: "user", content: [...context.messages].reverse().find((message) => message.role === "user")!.content },
        ]);
      }
      const historyText = "[User]: old question\n\n[Assistant]: old answer";
      const currentText = `before native\n\nbetween ${imagePath} after path`;
      const payload = payloads.at(-1);
      if (id === "cli") {
        assert.ok(runtimes[0] instanceof CliRuntimeSession);
        assert.equal(payload, scenario === "rebuild" || scenario === "system-tail" ? `[System]: rule\n\n${historyText}\n\n${currentText}`
          : standalone ? `[System]: rule\n\nold question\n\nold answer\n\n${currentText}`
          : scenario === "updates" ? [
            "steer\n## User\nnot a role",
            "[System]: # Conversation updates\n\n## System\n\n> \n\n### System section remove: policy",
            currentText,
          ].join("\n\n") : currentText);
      } else {
        assert.ok(runtimes[0] instanceof AcpRuntimeSession);
        assert.equal(runtimes[0].options.systemPrompt, standalone ? "rule" : composeSystemPrompt(prepareSystemMessages(context)));
        assert.deepEqual(payload, [
          ...(scenario === "rebuild" || scenario === "system-tail" ? [{ type: "text", text: historyText }] : []),
          ...(standalone ? [{ type: "text", text: "old question" }, { type: "text", text: "old answer" }] : []),
          ...(scenario === "updates" ? [{ type: "text", text: "steer\n## User\nnot a role" }] : []),
          { type: "text", text: "before native" }, nativeImage,
          { type: "text", text: `between ${imagePath}` },
          { type: "image", data: png, mimeType: "image/png" },
          { type: "text", text: " after path" },
        ]);
        assert.ok(!JSON.stringify(payload).includes("rule"));
      }
    });
  }
}
