import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { isRetryableAssistantError, retryAssistantCall, type Context, type Model, type RetryPolicy } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CapabilityGateway } from "../bridge/capabilities.ts";
import { BridgeIPC } from "../bridge/ipc.ts";
import { Driver as AcpDriver } from "../drivers/acp/driver.ts";
import { useExecutable } from "../drivers/acp/executable-fixture.ts";
import { Connection as AcpConnection } from "../drivers/acp/connection.ts";
import { RuntimeSession as AcpRuntimeSession } from "../drivers/acp/runtime.ts";
import { Session as AcpSession } from "../drivers/acp/session.ts";
import { Connection as CliConnection } from "../drivers/cli/connection.ts";
import { Driver as CliDriver } from "../drivers/cli/driver.ts";
import { AcpSessionClient, RuntimeSession as CliRuntimeSession } from "../drivers/cli/runtime.ts";
import type { DriverId } from "../drivers/types.ts";
import { useAuthHomeFixture } from "./auth-home-fixture.ts";
import { Bridge, streamProvider } from "./provider.ts";

useAuthHomeFixture();

const testModel: Model<"agy"> = {
  id: "selected",
  name: "Synthetic",
  api: "agy",
  provider: "agy",
  baseUrl: "agy",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const fastRetryPolicy: RetryPolicy = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 1,
  maxAgentDelayMs: 5,
};

async function createDriverFixture(t: TestContext, driverId: DriverId) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `agy-recovery-${driverId}-`));
  const previousGeminiHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = directory;
  t.after(async () => {
    if (previousGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = previousGeminiHome;
    await rm(directory, { recursive: true, force: true });
  });

  const fixturePath = fileURLToPath(new URL("../drivers/acp/session-fixture.ts", import.meta.url));
  const executable = path.join(directory, driverId === "cli" ? "agy" : "acp");
  const script = driverId === "cli"
    ? `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Antigravity CLI 1.23.2"; exit 0; fi\nexec "${process.execPath}" --experimental-strip-types "${fixturePath}"\n`
    : `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${fixturePath}"\n`;
  await writeFile(executable, script, { mode: 0o755 });

  const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
  const driver = driverId === "cli" ? new CliDriver() : new AcpDriver();
  if (driver instanceof CliDriver) {
    let running = false;
    t.mock.method(driver, "detectExecutable", () => executable);
    t.mock.method(driver, "installPlugin", async () => {});
    t.mock.getter(CliConnection.prototype, "isRunning", () => running);
    t.mock.method(CliConnection.prototype, "start", async () => {
      running = true;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      };
    });
    t.mock.method(CliConnection.prototype, "dispose", async () => {
      running = false;
    });
    t.mock.method(CliConnection.prototype, "request", async (method: string) => {
      if (method === "session/new" || method === "session/load") {
        return {
          sessionId: "synthetic-session",
          configOptions: [
            { id: "model", name: "model", type: "select" as const, currentValue: "default", options: [{ name: "selected", value: "selected" }] },
            { id: "thinking_level", name: "thinking_level", type: "select" as const, currentValue: "low", options: [{ name: "low", value: "low" }, { name: "high", value: "high" }] },
          ],
        };
      }
      if (method === "session/set_config_option" || method === "session/setConfigOption") {
        return {
          configOptions: [
            { id: "model", name: "model", type: "select" as const, currentValue: "selected", options: [{ name: "selected", value: "selected" }] },
            { id: "thinking_level", name: "thinking_level", type: "select" as const, currentValue: "low", options: [{ name: "low", value: "low" }, { name: "high", value: "high" }] },
          ],
        };
      }
      return { stopReason: "end_turn" as const };
    });
    t.mock.method(CliConnection.prototype, "notify", async () => {});
  } else {
    useExecutable(t, executable);
  }

  const bridge = new Bridge(pi, driver);
  const sessionId = bridge.piContextAdapter.bind(SessionManager.inMemory(directory));
  const session = bridge.liveSessions.getOrCreate(sessionId);
  t.after(async () => {
    await bridge.liveSessions.disposeAll();
  });

  t.mock.method(BridgeIPC.prototype, "start", async () => {});
  t.mock.getter(BridgeIPC.prototype, "bridgeUri", () => "unix:///synthetic.sock");
  t.mock.method(BridgeIPC.prototype, "close", async () => {});

  return { bridge, sessionId, session, directory };
}

describe("ACP and CLI fault injection and Pi native retry integration", () => {
  const drivers: DriverId[] = ["acp", "cli"];

  const retryablePreDispatchCases: {
    name: string;
    injectFailure: (t: TestContext, driverId: DriverId, shouldFail: () => boolean) => void;
    expectedFirstError: RegExp;
  }[] = [
    {
      name: "process exit during startup triggers Pi retry and reconstructs runtime",
      injectFailure: (t, driverId, shouldFail) => {
        const Target = driverId === "cli" ? CliConnection : AcpConnection;
        const original = Target.prototype.start;
        t.mock.method(Target.prototype, "start", async function (this: AcpConnection | CliConnection, signal?: AbortSignal) {
          if (shouldFail()) throw new Error("ACP process closed (23)");
          return original.call(this as any, signal);
        });
      },
      expectedFirstError: /ACP connection error: ACP process closed \(23\)/,
    },
    {
      name: "transport closure during initialization triggers Pi retry and reconstructs runtime",
      injectFailure: (t, driverId, shouldFail) => {
        const Target = driverId === "cli" ? CliConnection : AcpConnection;
        const original = Target.prototype.start;
        t.mock.method(Target.prototype, "start", async function (this: AcpConnection | CliConnection, signal?: AbortSignal) {
          if (shouldFail()) throw new Error("ACP transport closed");
          return original.call(this as any, signal);
        });
      },
      expectedFirstError: /ACP connection error: ACP transport closed/,
    },
    {
      name: "request timeout during session initialization triggers Pi retry and reconstructs runtime",
      injectFailure: (t, driverId, shouldFail) => {
        const Target = driverId === "cli" ? AcpSessionClient : AcpSession;
        const original = Target.prototype.prepare;
        t.mock.method(Target.prototype, "prepare", async function (this: AcpSession | AcpSessionClient, signal?: AbortSignal) {
          if (shouldFail()) throw new Error("ACP request timeout: session/new");
          return original.call(this as any, signal);
        });
      },
      expectedFirstError: /ACP request timeout: session\/new/,
    },
    {
      name: "connection failure before prompt dispatch triggers Pi retry and reconstructs runtime",
      injectFailure: (t, driverId, shouldFail) => {
        const Target = driverId === "cli" ? CliRuntimeSession : AcpRuntimeSession;
        const original = Target.prototype.submit;
        t.mock.method(Target.prototype, "submit", async function (this: AcpRuntimeSession | CliRuntimeSession, input: Parameters<AcpRuntimeSession["submit"]>[0]) {
          if (shouldFail()) throw new Error("ACP runtime closed before input delivery");
          return original.call(this as any, input);
        });
      },
      expectedFirstError: /ACP connection error: ACP runtime closed before input delivery/,
    },
  ];

  for (const driverId of drivers) {
    for (const row of retryablePreDispatchCases) {
      test(`[${driverId}] ${row.name}`, async (t) => {
        const { bridge, sessionId, session } = await createDriverFixture(t, driverId);
        t.mock.method(bridge, "getTools", () => []);
        const TargetPrompt = driverId === "cli" ? AcpSessionClient : AcpSession;
        let promptCalls = 0;
        t.mock.method(TargetPrompt.prototype, "prompt", async () => {
          promptCalls++;
          return { stopReason: "end_turn" as const };
        });

        let attempts = 0;
        const scheduledErrors: string[] = [];
        row.injectFailure(t, driverId, () => attempts === 1);

        const context: Context = {
          tools: [],
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        };

        const result = await retryAssistantCall(
          async () => {
            attempts++;
            return streamProvider(testModel, context, { sessionId }, bridge).result();
          },
          fastRetryPolicy,
          undefined,
          {
            onRetryScheduled: (_attempt, _maxAttempts, _delayMs, errorMessage) => {
              scheduledErrors.push(errorMessage);
            },
          },
        );

        assert.equal(attempts, 2);
        assert.equal(promptCalls, 1);
        assert.equal(scheduledErrors.length, 1);
        assert.match(scheduledErrors[0]!, row.expectedFirstError);
        assert.equal(result.stopReason, "stop");
        assert.equal(session.activeProcess?.isRunning, true);
      });
    }
  }

  const nonRetryableAndUnknownCases: {
    name: string;
    injectFailure: (t: TestContext, driverId: DriverId) => void;
    expectedStopReason: "error" | "aborted";
    expectedErrorPattern: RegExp;
  }[] = [
    {
      name: "authentication failure (-32000) is non-retryable and does not trigger Pi retry",
      injectFailure: (t, driverId) => {
        const Target = driverId === "cli" ? AcpSessionClient : AcpSession;
        t.mock.method(Target.prototype, "prepare", async () => {
          throw new acp.RequestError(-32000, "Authentication required. Run /login to authenticate.");
        });
      },
      expectedStopReason: "error",
      expectedErrorPattern: /Authentication required/,
    },
    {
      name: "authentication failure wrapped in -32603 Internal error data.details is non-retryable",
      injectFailure: (t, driverId) => {
        const Target = driverId === "cli" ? AcpSessionClient : AcpSession;
        t.mock.method(Target.prototype, "prompt", async () => {
          throw new acp.RequestError(-32603, "Internal error", { details: "Authentication required: invalid credentials" });
        });
      },
      expectedStopReason: "error",
      expectedErrorPattern: /agent failure: Authentication required: invalid credentials/,
    },
    {
      name: "quota exceeded wrapped in -32603 Internal error data.details is non-retryable",
      injectFailure: (t, driverId) => {
        const Target = driverId === "cli" ? AcpSessionClient : AcpSession;
        t.mock.method(Target.prototype, "prompt", async () => {
          throw new acp.RequestError(-32603, "Internal error", { details: "Quota exceeded for quota metric" });
        });
      },
      expectedStopReason: "error",
      expectedErrorPattern: /Quota exceeded for quota metric/,
    },
    {
      name: "connection failure during active prompt is classified as unknown and does not trigger Pi retry",
      injectFailure: (t, driverId) => {
        const Target = driverId === "cli" ? AcpSessionClient : AcpSession;
        t.mock.method(Target.prototype, "prompt", async () => {
          throw new Error("ACP process closed (1)");
        });
      },
      expectedStopReason: "error",
      expectedErrorPattern: /ACP process closed \(1\)/,
    },
    {
      name: "timeout during active prompt is classified as unknown and sanitized against Pi retry",
      injectFailure: (t, driverId) => {
        const Target = driverId === "cli" ? AcpSessionClient : AcpSession;
        t.mock.method(Target.prototype, "prompt", async () => {
          throw new Error("ACP request timeout: session/prompt");
        });
      },
      expectedStopReason: "error",
      expectedErrorPattern: /ACP request deadline exceeded: session\/prompt/,
    },
  ];

  for (const driverId of drivers) {
    for (const row of nonRetryableAndUnknownCases) {
      test(`[${driverId}] ${row.name}`, async (t) => {
        const { bridge, sessionId, session } = await createDriverFixture(t, driverId);
        t.mock.method(bridge, "getTools", () => []);
        row.injectFailure(t, driverId);

        let attempts = 0;
        const context: Context = {
          tools: [],
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        };

        const result = await retryAssistantCall(
          async () => {
            attempts++;
            return streamProvider(testModel, context, { sessionId }, bridge).result();
          },
          fastRetryPolicy,
          undefined,
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(attempts, 1, "Non-retryable or unknown failure must not trigger Pi retry");
        assert.equal(result.stopReason, row.expectedStopReason);
        assert.match(result.errorMessage ?? "", row.expectedErrorPattern);
        assert.equal(isRetryableAssistantError(result), false);
        assert.equal(session.activeProcess, null);
        assert.equal(session.activeMcpServer, null);
      });
    }
  }

  for (const driverId of drivers) {
    test(`[${driverId}] user cancellation aborts cleanly without triggering Pi retry`, async (t) => {
      const { bridge, sessionId, session } = await createDriverFixture(t, driverId);
      t.mock.method(bridge, "getTools", () => []);
      const controller = new AbortController();
      const Target = driverId === "cli" ? AcpSessionClient : AcpSession;
      let rejectPending!: (error: Error) => void;
      const originalCancel = Target.prototype.cancel;
      t.mock.method(Target.prototype, "cancel", async function (this: AcpSession | AcpSessionClient) {
        try { await originalCancel.call(this as any); }
        finally { rejectPending?.(new Error("cancelled")); }
      });
      t.mock.method(Target.prototype, "prompt", async () => {
        setImmediate(() => controller.abort(new Error("user cancelled")));
        return new Promise((_resolve, reject) => {
          rejectPending = reject;
        });
      });

      let attempts = 0;
      const context: Context = {
        tools: [],
        messages: [{ role: "user", content: "Cancel me", timestamp: 1 }],
      };

      const result = await retryAssistantCall(
        async () => {
          attempts++;
          return streamProvider(testModel, context, { sessionId, signal: controller.signal }, bridge).result();
        },
        fastRetryPolicy,
        controller.signal,
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(attempts, 1);
      assert.equal(result.stopReason, "aborted");
      assert.equal(isRetryableAssistantError(result), false);
      assert.equal(session.activeProcess, null);
    });
  }

  for (const driverId of drivers) {
    test(`[${driverId}] failure after completed MCP tool call is unknown, prevents duplicate tool execution, and reconstructs context on next turn`, async (t) => {
      const { bridge, sessionId, session } = await createDriverFixture(t, driverId);
      const tools = [{ name: "read", description: "Read file", parameters: { type: "object", properties: {} } }];
      const gateway = new CapabilityGateway(tools, session.resources);
      t.after(() => gateway.cancelPendingCalls("cleanup"));
      t.mock.method(bridge, "getTools", () => tools);
      t.mock.getter(BridgeIPC.prototype, "hasPendingCalls", () => gateway.hasPendingCalls);
      t.mock.method(BridgeIPC.prototype, "setToolCallHandler", (handler: Parameters<BridgeIPC["setToolCallHandler"]>[0]) => gateway.setToolCallHandler(handler));
      t.mock.method(BridgeIPC.prototype, "resolveToolResults", (messages: Context["messages"], appendix?: string) => gateway.resolveToolResults(messages, appendix));
      t.mock.method(BridgeIPC.prototype, "close", async () => { gateway.cancelPendingCalls("closed"); });

      const Target = driverId === "cli" ? AcpSessionClient : AcpSession;
      let toolCallCount = 0;
      const receivedPrompts: acp.ContentBlock[][] = [];
      t.mock.method(Target.prototype, "prompt", async function (content: acp.ContentBlock[]) {
        receivedPrompts.push(content);
        if (receivedPrompts.length === 1) {
          toolCallCount++;
          await gateway.call("read", { path: "important.txt" });
          throw new acp.RequestError(-32603, "Internal error", { details: "503 Service Unavailable: upstream connection lost" });
        }
        return { stopReason: "end_turn" as const };
      });

      const initialContext: Context = {
        tools,
        messages: [{ role: "user", content: "Read important.txt", timestamp: 1 }],
      };

      const firstTurn = await streamProvider(testModel, initialContext, { sessionId }, bridge).result();
      assert.equal(firstTurn.stopReason, "toolUse");
      assert.equal(toolCallCount, 1);
      const firstRuntime = session.activeProcess;
      assert.ok(firstRuntime);

      const toolCall = firstTurn.content.find((part) => part.type === "toolCall");
      assert.ok(toolCall?.type === "toolCall");
      const toolResult = {
        role: "toolResult" as const,
        toolCallId: toolCall.id,
        toolName: "read",
        content: [{ type: "text" as const, text: "FILE_CONTENT_123" }],
        isError: false,
        timestamp: 2,
      };
      const continuationContext: Context = {
        tools,
        messages: [...initialContext.messages, firstTurn, toolResult],
      };

      let continuationAttempts = 0;
      const scheduled: string[] = [];
      const secondTurn = await retryAssistantCall(
        async () => {
          continuationAttempts++;
          return streamProvider(testModel, continuationContext, { sessionId }, bridge).result();
        },
        fastRetryPolicy,
        undefined,
        {
          onRetryScheduled: (_a, _m, _d, err) => {
            scheduled.push(err);
          },
        },
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(continuationAttempts, 1, `Failure after tool execution must not be retried by Pi (scheduled=${JSON.stringify(scheduled)}, error=${secondTurn.errorMessage})`);
      assert.equal(toolCallCount, 1, "No duplicate tool execution may occur");
      assert.equal(secondTurn.stopReason, "error");
      assert.match(secondTurn.errorMessage ?? "", /execution outcome unknown after tool activity; automatic replay disabled/);
      assert.equal(isRetryableAssistantError(secondTurn), false);
      assert.equal(session.activeProcess, null, "Failed runtime must be disposed and invalidated");
      assert.equal(await bridge.runtimeSessionStore.get(sessionId, bridge.driver.sessionVersion), undefined);

      // Subsequent request establishes a fresh runtime and restores session context
      const recoveryContext: Context = {
        tools,
        messages: [
          ...continuationContext.messages,
          { role: "user", content: "Continue after the error", timestamp: 3 },
        ],
      };

      const thirdTurn = await streamProvider(testModel, recoveryContext, { sessionId }, bridge).result();
      assert.equal(thirdTurn.stopReason, "stop");
      assert.ok(session.activeProcess);
      assert.notEqual(session.activeProcess, firstRuntime, "Failed runtime must not be reused");
      assert.equal(receivedPrompts.length, 2);
      const reconstructedPrompt = JSON.stringify(receivedPrompts[1]);
      assert.ok(reconstructedPrompt.includes("Read important.txt"), "Reconstructed context must include prior user prompt");
      assert.ok(reconstructedPrompt.includes("Continue after the error"), "Reconstructed context must include new user prompt");
    });
  }
});
