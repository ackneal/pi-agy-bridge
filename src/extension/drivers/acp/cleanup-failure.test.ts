import assert from "node:assert/strict";
import test from "node:test";
import { AcpRuntimeSession } from "./runtime.ts";
import { AcpSession } from "./session.ts";
import type { DriverSubmission, RuntimeEvent } from "../types.ts";

for (const mode of ["prompt rejection", "transport close", "abort"] as const) {
  test(`cleanup rejection preserves completion after ${mode}`, async (t) => {
    const runtime = new AcpRuntimeSession({ executable: "unused", cwd: process.cwd(), model: "selected",
      mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
    // Mock only the public session boundary; invoke the real registered close callback.
    const sessionOptions = (runtime.session as unknown as { options: { onClose: (error: unknown) => void } }).options;
    const events: RuntimeEvent[] = [];
    runtime.onRuntimeEvent(event => events.push(event));
    t.mock.getter(AcpSession.prototype, "isRunning", () => true);
    t.mock.getter(AcpSession.prototype, "id", () => "synthetic-session");
    const original = new Error("original runtime failure");
    const dispose = t.mock.method(AcpSession.prototype, "dispose", async () => {
      sessionOptions.onClose(original);
      throw new Error("session disposal failure");
    });
    t.mock.method(AcpSession.prototype, "cancel", async () => { sessionOptions.onClose(original); });
    t.mock.method(AcpSession.prototype, "prompt", async () => {
      if (mode === "transport close") sessionOptions.onClose(original);
      throw original;
    });
    const input: DriverSubmission = {
      model: { id: "selected", name: "Synthetic", api: "anthropic-messages", provider: "anthropic",
        baseUrl: "https://example.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false, contextWindow: 1000, maxTokens: 100 },
      context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      options: undefined, reconstructContext: true, syncedMessageCount: 0, beforeInput: () => true,
    };
    if (mode === "abort") {
      await runtime.abort();
    } else {
      await runtime.submit(input);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(dispose.mock.callCount(), 1);
    const terminal = events.filter(event => event.type === "complete");
    assert.equal(terminal.length, mode === "abort" ? 0 : 1);
    if (mode !== "abort") {
      assert.equal(terminal[0]?.reason, "error");
      assert.match(terminal[0]?.error ?? "", /original runtime failure/);
    }
  });
}
