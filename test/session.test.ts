import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { calculateSyncKey, LiveSession, LiveSessionRegistry, PiContextAdapter } from "../src/session.ts";
import type { AgyProcess } from "../src/process.ts";
import type { AgyMcpServer } from "../src/bridge-ipc.ts";

describe("calculateSyncKey", () => {
  it("is deterministic, canonicalizes tool order, and includes all key components", () => {
    const key1 = calculateSyncKey("You are a helpful assistant", ["bash", "read_file"], "gemini-3.8-flash-high", "", "pi-bridge");
    assert.equal(calculateSyncKey("You are a helpful assistant", ["bash", "read_file"], "gemini-3.8-flash-high", "", "pi-bridge"), key1);
    assert.equal(calculateSyncKey("Prompt", ["gamma", "alpha", "beta"], "claude-sonnet-4-6", "high", "pi-bridge"), "Prompt::alpha,beta,gamma::claude-sonnet-4-6::high::pi-bridge");
    assert.equal(key1, "You are a helpful assistant::bash,read_file::gemini-3.8-flash-high::pi-bridge");
  });

  const diffCases: {
    name: string;
    args1: [string, readonly string[], string, string?, string?];
    args2: [string, readonly string[], string, string?, string?];
  }[] = [
    {
      name: "system prompt change",
      args1: ["Prompt A", ["tool1"], "model1", "", "agent"],
      args2: ["Prompt B", ["tool1"], "model1", "", "agent"],
    },
    {
      name: "tools change",
      args1: ["Prompt A", ["tool1"], "model1", "", "agent"],
      args2: ["Prompt A", ["tool1", "tool2"], "model1", "", "agent"],
    },
    {
      name: "model change",
      args1: ["Prompt A", ["tool1"], "model1", "", "agent"],
      args2: ["Prompt A", ["tool1"], "model2", "", "agent"],
    },
    {
      name: "effort change",
      args1: ["Prompt A", ["tool1"], "model1", "low", "agent"],
      args2: ["Prompt A", ["tool1"], "model1", "high", "agent"],
    },
    {
      name: "agent name change",
      args1: ["Prompt A", ["tool1"], "model1", "", "agent-1"],
      args2: ["Prompt A", ["tool1"], "model1", "", "agent-2"],
    },
  ];

  it("changes when any synchronization input changes", () => {
    for (const tc of diffCases) {
      assert.notEqual(calculateSyncKey(...tc.args1), calculateSyncKey(...tc.args2), tc.name);
    }
  });
});

describe("LiveSession", () => {
  it("tracks the owning Pi session", () => {
    const session = new LiveSession("pi-session-a");
    assert.equal(session.piSessionId, "pi-session-a");
    assert.equal(session.activeProcess, null);
    assert.equal(session.syncKey, "");
    assert.equal(session.turnIndex, 0);
    assert.equal(session.conversationId, undefined);
  });

  it("disposes MCP and process resources and clears live state", async () => {
    const session = new LiveSession("pi-session-a");
    const lifecycle: string[] = [];
    const mockProc = {
      isRunning: true,
      abort: async () => lifecycle.push("process"),
    } as unknown as AgyProcess;
    const mockMcpServer = {
      close: async () => lifecycle.push("mcp"),
    } as unknown as AgyMcpServer;

    session.setSession(mockProc, "key-123", mockMcpServer, "agy-conversation");
    await session.dispose();

    assert.deepEqual(lifecycle, ["mcp", "process"]);
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(session.syncKey, "");
    assert.equal(session.turnIndex, 0);
    assert.equal(session.conversationId, undefined);
  });
});

describe("PiContextAdapter", () => {
  it("does not route a stale session ID through a switched SessionManager", () => {
    let activeSessionId = "pi-session-a";
    const manager = {
      getSessionId: () => activeSessionId,
    } as SessionManager;
    const adapter = new PiContextAdapter();

    adapter.bind(manager);
    activeSessionId = "pi-session-b";
    adapter.bind(manager);

    assert.equal(adapter.getSessionManager("pi-session-a"), undefined);
    assert.equal(adapter.getSessionManager("pi-session-b"), manager);
  });
});

describe("LiveSessionRegistry", () => {
  it("keeps independently keyed Pi sessions isolated", async () => {
    const registry = new LiveSessionRegistry();
    const sessionA = registry.getOrCreate("pi-session-a");
    const sessionB = registry.getOrCreate("pi-session-b");

    assert.notEqual(sessionA, sessionB);
    assert.notEqual(sessionA.id, sessionB.id);
    assert.equal(registry.get("pi-session-a"), sessionA);
    assert.equal(registry.get("pi-session-b"), sessionB);

    await registry.remove("pi-session-a");
    assert.equal(registry.get("pi-session-a"), undefined);
    assert.equal(registry.get("pi-session-b"), sessionB);
    await registry.disposeAll();
  });
});

