import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { calculateSyncKey, LiveSession, LiveSessionRegistry, PiContextAdapter } from "./session.ts";
import type { DriverSession } from "../drivers/types.ts";
import type { AgyMcpServer } from "../bridge/bridge-ipc.ts";

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
  type EventHandler = Parameters<DriverSession["onRuntimeEvent"]>[0];

  function createRuntime(abort: () => Promise<void> = async () => {}) {
    const subscriptions: { handler: EventHandler; unsubscribeCalls: number }[] = [];
    const runtime: DriverSession = {
      driver: "cli", isRunning: true,
      formatContextUpdate: () => "", submit: async () => {},
      onRuntimeEvent: (handler: EventHandler) => {
        const subscription = { handler, unsubscribeCalls: 0 };
        subscriptions.push(subscription);
        return () => { subscription.unsubscribeCalls++; };
      },
      abort,
    };

    return {
      runtime,
      subscriptions,
      emit: (...args: Parameters<EventHandler>) => {
        for (const subscription of subscriptions) {
          if (subscription.unsubscribeCalls === 0) subscription.handler(...args);
        }
      },
    };
  }

  for (const cleanup of ["dispose", "disposeAll", "remove"] as const) {
    it(`awaits in-flight cleanup through ${cleanup}`, async () => {
      const registry = new LiveSessionRegistry();
      const session = registry.getOrCreate("pi-session-a");
      const lifecycle: string[] = [];
      let releaseClose!: () => void;
      const closing = new Promise<void>((resolve) => { releaseClose = resolve; });
      const mock = createRuntime(async () => { lifecycle.push("process"); });
      const mcp = { close: async () => {
        lifecycle.push("mcp");
        await closing;
      } } as unknown as AgyMcpServer;
      session.setSession(mock.runtime, "key", mcp, "conversation");
      const controller = new AbortController();
      let initialDisposal: Promise<void> | undefined;
      session.setAbortSignal(controller.signal, () => { initialDisposal = session.dispose(); });

      controller.abort();
      let completed = false;
      const cleanupTask = (cleanup === "dispose" ? session.dispose()
        : cleanup === "disposeAll" ? registry.disposeAll() : registry.remove(session.piSessionId))
        .then(() => { completed = true; });

      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(session.activeProcess, null);
        assert.equal(session.activeMcpServer, null);
        assert.equal(completed, false);
        assert.deepEqual(lifecycle, ["mcp"]);

        releaseClose();
        await cleanupTask;
        assert.equal(completed, true);
        assert.deepEqual(lifecycle, ["mcp", "process"]);
      } finally {
        releaseClose();
        await initialDisposal;
        await cleanupTask;
        await registry.disposeAll();
      }
    });
  }

  for (const row of [
    { name: "replaces the owned handler", handlers: [0, 1], unsubscribeCalls: [1, 0], activeHandler: 1 },
    { name: "resubscribes the same handler exactly once", handlers: [0, 0], unsubscribeCalls: [1, 0], activeHandler: 0 },
    { name: "clears the owned handler exactly once", handlers: [0, null, null], unsubscribeCalls: [1], activeHandler: null },
    { name: "ignores handlers without a process", handlers: [0, null, 1], absentProcess: true, unsubscribeCalls: [], activeHandler: null },
    { name: "releases the old handler when replacing without a process", handlers: [0, 1], detachProcess: true, unsubscribeCalls: [1], activeHandler: null },
    { name: "releases the old handler when clearing without a process", handlers: [0, null, null], detachProcess: true, unsubscribeCalls: [1], activeHandler: null },
  ]) {
    it(row.name, async () => {
      const session = new LiveSession("pi-session-a");
      const mock = createRuntime();
      const events: { handler: number; args: Parameters<EventHandler> }[] = [];
      const handlers: EventHandler[] = [0, 1].map((handler) => (...args) => events.push({ handler, args }));
      if (!row.absentProcess) session.setSession(mock.runtime, "key");

      try {
        for (const [index, handler] of row.handlers.entries()) {
          if (row.detachProcess && index === 1) session.activeProcess = null;
          session.setRuntimeEventHandler(handler === null ? null : handlers[handler]!);
        }
        mock.emit({ type: "complete", reason: "stop", resumable: true });
        mock.emit({ type: "complete", reason: "error", resumable: false });

        assert.deepEqual(mock.subscriptions.map((subscription) => subscription.unsubscribeCalls), row.unsubscribeCalls);
        assert.deepEqual(events, row.activeHandler === null ? [] : [
          { handler: row.activeHandler, args: [{ type: "complete", reason: "stop", resumable: true }] },
          { handler: row.activeHandler, args: [{ type: "complete", reason: "error", resumable: false }] },
        ]);
      } finally {
        await session.dispose();
      }
      assert.ok(mock.subscriptions.every((subscription) => subscription.unsubscribeCalls === 1));
    });
  }

  for (const row of [
    { name: "releases the current preparation", release: "current", ownsCurrent: false },
    { name: "cannot release a newer preparation with an old token", release: "old", ownsCurrent: true },
    { name: "ignores an unrelated preparation release", release: "unrelated", ownsCurrent: true },
  ]) {
    it(row.name, async () => {
      const session = new LiveSession("pi-session-a");
      const old = session.beginPreparation();
      const current = session.beginPreparation();

      try {
        assert.notEqual(old, current);
        assert.equal(session.ownsPreparation(old), false);
        assert.equal(session.ownsPreparation(current), true);
        const token = row.release === "current" ? current : row.release === "old" ? old : Symbol();
        session.releasePreparation(token);
        session.releasePreparation(token);

        assert.equal(session.ownsPreparation(old), false);
        assert.equal(session.ownsPreparation(current), row.ownsCurrent);
      } finally {
        await session.dispose();
      }
    });
  }

  for (const row of [
    { name: "installs without a preparation token", token: "absent", installed: true },
    { name: "installs with the owned preparation token", token: "current", installed: true },
    { name: "rejects installation with a superseded preparation token", token: "old", installed: false },
    { name: "rejects installation with a released preparation token", token: "released", installed: false },
    { name: "rejects installation with an unrelated preparation token", token: "unrelated", installed: false },
  ]) {
    it(row.name, async () => {
      const session = new LiveSession("pi-session-a");
      const existing = createRuntime();
      const replacement = createRuntime();
      const existingMcp = { close: async () => {} } as unknown as AgyMcpServer;
      const replacementMcp = { close: async () => {} } as unknown as AgyMcpServer;
      session.setSession(existing.runtime, "existing-key", existingMcp, "existing-conversation");
      const old = session.beginPreparation();
      const current = session.beginPreparation();
      if (row.token === "released") session.releasePreparation(current);
      const token = row.token === "absent" ? undefined
        : row.token === "old" ? old
        : row.token === "unrelated" ? Symbol()
        : current;

      try {
        const installed = session.setSession(replacement.runtime, "replacement-key", replacementMcp, "replacement-conversation", token);

        assert.equal(installed, row.installed);
        assert.equal(session.activeProcess, row.installed ? replacement.runtime : existing.runtime);
        assert.equal(session.activeMcpServer, row.installed ? replacementMcp : existingMcp);
        assert.equal(session.syncKey, row.installed ? "replacement-key" : "existing-key");
        assert.equal(session.conversationId, row.installed ? "replacement-conversation" : "existing-conversation");
        assert.equal(session.ownsPreparation(current), row.token !== "released");
      } finally {
        await session.dispose();
      }
    });
  }

  for (const row of [
    { name: "superseded", token: "old" },
    { name: "released", token: "released" },
    { name: "unrelated", token: "unrelated" },
  ]) {
    it(`ignores disposal with ${row.name} preparation token`, async () => {
      const session = new LiveSession("pi-session-a");
      const lifecycle: string[] = [];
      const mock = createRuntime(async () => { lifecycle.push("process"); });
      const mcp = { close: async () => { lifecycle.push("mcp"); } } as unknown as AgyMcpServer;
      const controller = new AbortController();
      const events: string[] = [];
      session.setSession(mock.runtime, "key", mcp, "conversation");
      session.setRuntimeEventHandler(() => { events.push("event"); });
      session.setAbortSignal(controller.signal, () => { events.push("abort"); });
      const handle = session.resources.terminals.bind("pi-terminal");
      const old = session.beginPreparation();
      if (row.token === "released") session.releasePreparation(old);
      const current = session.beginPreparation();
      const token = row.token === "unrelated" ? Symbol() : old;

      try {
        await session.dispose({ preparationId: token });
        mock.emit({ type: "start" });
        controller.abort();

        assert.equal(session.ownsPreparation(current), true);
        assert.equal(session.activeProcess, mock.runtime);
        assert.equal(session.activeMcpServer, mcp);
        assert.equal(session.syncKey, "key");
        assert.equal(session.conversationId, "conversation");
        assert.equal(session.resources.terminals.resolve(handle), "pi-terminal");
        assert.equal(mock.subscriptions[0]!.unsubscribeCalls, 0);
        assert.deepEqual(events, ["event", "abort"]);
        assert.deepEqual(lifecycle, []);
      } finally {
        await session.dispose();
      }
    });
  }

  for (const stage of ["mcp", "process"]) {
    it(`concurrent disposal waits without repeating detached ${stage} cleanup`, async () => {
      const session = new LiveSession("pi");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const calls: string[] = [];
      const runtime = createRuntime(async () => {
        calls.push("process");
        if (stage === "process") await gate;
      });
      const mcp = { close: async () => {
        calls.push("mcp");
        if (stage === "mcp") await gate;
      } } as unknown as AgyMcpServer;
      const token = session.beginPreparation();
      session.setSession(runtime.runtime, "key", mcp, "conversation", token);
      const handle = session.resources.terminals.bind("terminal");
      const first = session.dispose({ preparationId: token, preserveResources: true, preserveConversation: true });
      const second = session.dispose({ preparationId: token, preserveResources: true, preserveConversation: true });

      let completed = false;
      void second.then(() => { completed = true; });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(completed, false);
        assert.deepEqual(calls, stage === "mcp" ? ["mcp"] : ["mcp", "process"]);
        assert.equal(session.activeProcess, null);
        assert.equal(session.syncKey, "");
        assert.equal(session.conversationId, "conversation");
        assert.equal(session.resources.terminals.resolve(handle), "terminal");
        assert.equal(session.ownsPreparation(token), true);
        release();
        await Promise.all([first, second]);
        assert.deepEqual(calls, ["mcp", "process"]);
      } finally {
        release();
        await Promise.all([first, second]);
        await session.dispose();
      }
    });
  }

  it("tracks the owning Pi session", () => {
    const session = new LiveSession("pi-session-a");
    assert.equal(session.piSessionId, "pi-session-a");
    assert.equal(session.activeProcess, null);
    assert.equal(session.activeMcpServer, null);
    assert.equal(session.syncKey, "");
    assert.equal(session.conversationId, undefined);
  });

  for (const row of [
    { name: "full disposal clears terminal handles", options: undefined, terminalId: undefined },
    { name: "runtime replacement preserves terminal handles", options: { preserveResources: true }, terminalId: "pi-terminal" },
  ]) {
    it(row.name, async () => {
      const session = new LiveSession("pi-session-a");
      const lifecycle: string[] = [];
      const mockProc: DriverSession = {
        driver: "cli", formatContextUpdate: () => "", submit: async () => {},
        isRunning: true,
        onRuntimeEvent: () => () => { lifecycle.push("unsubscribe"); },
        abort: async () => { lifecycle.push("process"); },
      };
      const mockMcpServer = {
        close: async () => lifecycle.push("mcp"),
      } as unknown as AgyMcpServer;

      const controller = new AbortController();
      const preparationId = session.beginPreparation();
      session.setSession(mockProc, "key-123", mockMcpServer, "agy-conversation");
      session.setRuntimeEventHandler(() => {});
      session.setAbortSignal(controller.signal, () => { lifecycle.push("cancel"); });
      const handle = session.resources.terminals.bind("pi-terminal");
      const disposal = session.dispose(row.options);

      try {
        controller.abort();
        assert.equal(session.ownsPreparation(preparationId), false);
        assert.deepEqual(lifecycle, ["unsubscribe", "mcp"]);
        assert.equal(session.activeProcess, null);
        assert.equal(session.activeMcpServer, null);
        assert.equal(session.syncKey, "");
        assert.equal(session.conversationId, undefined);
        assert.equal(session.resources.terminals.resolve(handle), row.terminalId);

        await disposal;
        assert.deepEqual(lifecycle, ["unsubscribe", "mcp", "process"]);
      } finally {
        await disposal;
        await session.dispose();
      }
      assert.equal(session.resources.terminals.resolve(handle), undefined);
      assert.deepEqual(lifecycle, ["unsubscribe", "mcp", "process"]);
    });
  }

  for (const row of [
    { name: "MCP", delayedStage: "mcp", preserveResources: false },
    { name: "MCP with preserved resources", delayedStage: "mcp", preserveResources: true },
    { name: "process", delayedStage: "process", preserveResources: false },
    { name: "process with preserved resources", delayedStage: "process", preserveResources: true },
  ].flatMap((row) => [
    { ...row, guarded: false },
    { ...row, name: `${row.name} and owned preparation`, guarded: true },
  ])) {
    it(`keeps replacement ownership during delayed ${row.name} cleanup`, async () => {
      const session = new LiveSession("pi-session-a");
      let release!: () => void;
      const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
      const lifecycle: string[] = [];
      const oldRuntime = createRuntime(async () => {
        lifecycle.push("old-process");
        if (row.delayedStage === "process") await cleanupGate;
      });
      const oldMcp = {
        close: async () => {
          lifecycle.push("old-mcp");
          if (row.delayedStage === "mcp") await cleanupGate;
        },
      } as unknown as AgyMcpServer;
      const replacement = createRuntime(async () => { lifecycle.push("new-process"); });
      const replacementMcp = {
        close: async () => { lifecycle.push("new-mcp"); },
      } as unknown as AgyMcpServer;
      const events: string[] = [];
      const cancellations: string[] = [];
      const oldController = new AbortController();
      const replacementController = new AbortController();
      const oldPreparation = session.beginPreparation();
      session.setSession(oldRuntime.runtime, "old-key", oldMcp, "old-conversation");
      session.setRuntimeEventHandler(() => { events.push("old"); });
      session.setAbortSignal(oldController.signal, () => { cancellations.push("old"); });
      const handle = session.resources.terminals.bind("pi-terminal");
      const disposal = session.dispose({
        preserveResources: row.preserveResources,
        ...(row.guarded ? { preparationId: oldPreparation } : {}),
      });

      try {
        oldController.abort();
        assert.equal(cancellations.length, 0);
        assert.equal(session.ownsPreparation(oldPreparation), row.guarded);
        assert.equal(oldRuntime.subscriptions[0]!.unsubscribeCalls, 1);
        assert.equal(session.activeProcess, null);
        assert.equal(session.resources.terminals.resolve(handle), row.preserveResources ? "pi-terminal" : undefined);
        oldRuntime.emit({ type: "start" });
        assert.equal(events.length, 0);
        if (row.delayedStage === "process") await Promise.resolve();
        assert.deepEqual(lifecycle, row.delayedStage === "mcp" ? ["old-mcp"] : ["old-mcp", "old-process"]);

        const replacementPreparation = session.beginPreparation();
        assert.equal(session.setSession(replacement.runtime, "new-key", replacementMcp, "new-conversation", replacementPreparation), true);
        session.setRuntimeEventHandler(() => { events.push("new"); });
        session.setAbortSignal(replacementController.signal, () => { cancellations.push("new"); });
        const replacementHandle = session.resources.terminals.bind("replacement-terminal");
        release();
        await disposal;
        oldRuntime.emit({ type: "start" });
        replacement.emit({ type: "start" });
        replacementController.abort();

        assert.equal(session.ownsPreparation(oldPreparation), false);
        assert.equal(session.ownsPreparation(replacementPreparation), true);
        assert.deepEqual(cancellations, ["new"]);
        assert.equal(oldRuntime.subscriptions[0]!.unsubscribeCalls, 1);
        assert.equal(replacement.subscriptions[0]!.unsubscribeCalls, 0);
        assert.deepEqual(events, ["new"]);
        assert.deepEqual(lifecycle, ["old-mcp", "old-process"]);
        assert.equal(session.activeProcess, replacement.runtime);
        assert.equal(session.activeMcpServer, replacementMcp);
        assert.equal(session.syncKey, "new-key");
        assert.equal(session.conversationId, "new-conversation");
        assert.equal(session.resources.terminals.resolve(replacementHandle), "replacement-terminal");
      } finally {
        release();
        await disposal;
        await session.dispose();
      }
      assert.equal(oldRuntime.subscriptions[0]!.unsubscribeCalls, 1);
      assert.equal(replacement.subscriptions[0]!.unsubscribeCalls, 1);
      assert.deepEqual(lifecycle, ["old-mcp", "old-process", "new-mcp", "new-process"]);
    });
  }
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

    try {
      assert.notEqual(sessionA, sessionB);
      assert.notEqual(sessionA.id, sessionB.id);
      assert.equal(registry.get("pi-session-a"), sessionA);
      assert.equal(registry.get("pi-session-b"), sessionB);
      assert.equal(registry.getOrCreate("pi-session-b"), sessionB);

      await registry.remove("pi-session-a");

      assert.equal(registry.get("pi-session-a"), undefined);
      assert.equal(registry.get("pi-session-b"), sessionB);
    } finally {
      await registry.disposeAll();
    }
    assert.equal(registry.get("pi-session-b"), undefined);
  });
});
