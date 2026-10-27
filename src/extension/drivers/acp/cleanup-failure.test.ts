import assert from "node:assert/strict";
import test from "node:test";
import { AcpRuntimeSession } from "./runtime.ts";
import { AcpSession } from "./session.ts";
import { AcpArtifactReader } from "./artifact-reader.ts";
import type { DriverSubmission, RuntimeEvent } from "../types.ts";

for (const mode of ["prompt rejection", "prompt success", "transport close", "synchronous close", "abort"] as const) {
  test(`cleanup rejection preserves completion after ${mode}`, async (t) => {
    const runtime = new AcpRuntimeSession({ executable: "unused", cwd: process.cwd(), model: "selected",
      mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
    // Mock only the public session boundary; invoke the real registered close callback.
    const sessionOptions = (runtime.session as unknown as { options: { onClose: (error: unknown) => void } }).options;
    const state = runtime as unknown as { completion: Promise<void> | undefined };
    const events: RuntimeEvent[] = [];
    runtime.onRuntimeEvent(event => events.push(event));
    t.mock.getter(AcpSession.prototype, "isRunning", () => true);
    t.mock.getter(AcpSession.prototype, "id", () => "synthetic-session");
    const original = new Error("original runtime failure");
    const end = t.mock.method(AcpArtifactReader.prototype, "endPrompt", async () => { throw new Error("reader cleanup failure"); });
    const dispose = t.mock.method(AcpSession.prototype, "dispose", async () => {
      sessionOptions.onClose(original);
      throw new Error("session disposal failure");
    });
    t.mock.method(AcpSession.prototype, "cancel", async () => { sessionOptions.onClose(original); });
    t.mock.method(AcpSession.prototype, "prompt", async () => {
      if (mode === "prompt success") return { stopReason: "end_turn" as const };
      if (mode === "synchronous close") sessionOptions.onClose(original);
      throw original;
    });
    const input: DriverSubmission = {
      model: { id: "selected", name: "Synthetic", api: "anthropic-messages", provider: "anthropic",
        baseUrl: "https://example.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false, contextWindow: 1000, maxTokens: 100 },
      context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      options: undefined, reconstructContext: true, syncedMessageCount: 0, beforeInput: () => true,
    };
    if (mode === "prompt rejection" || mode === "prompt success" || mode === "synchronous close") {
      await runtime.submit(input);
      const completion = state.completion!;
      await new Promise<void>(resolve => setImmediate(resolve));
      await assert.doesNotReject(completion);
    } else if (mode === "transport close") {
      sessionOptions.onClose(original);
      const completion = state.completion!;
      await new Promise<void>(resolve => setImmediate(resolve));
      await assert.doesNotReject(completion);
    } else {
      await assert.rejects(runtime.abort(), /reader cleanup failure/);
      await assert.doesNotReject(state.completion ?? Promise.resolve());
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(end.mock.callCount() > 0);
    assert.equal(dispose.mock.callCount(), 1);
    const terminal = events.filter(event => event.type === "complete");
    assert.equal(terminal.length, mode === "abort" ? 0 : 1);
    if (mode !== "abort") {
      assert.equal(terminal[0]?.reason, "error");
      assert.match(terminal[0]?.error ?? "", mode === "prompt success" ? /reader cleanup failure/ : /original runtime failure/);
    }
  });
}
