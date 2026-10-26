import { fingerprintAcpSystemPrompt } from "./instructions.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { acpContext, AcpRuntimeSession } from "./runtime.ts";

test("ACP context preserves images and does not filter artifact text", () => {
  const blocks = acpContext([{ role: "user", content: [{ type: "text", text: "artifact /tmp/example" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 0 }]);
  assert.deepEqual(blocks, [{ type: "text", text: "[user]" }, { type: "text", text: "artifact /tmp/example" }, { type: "image", data: "YWJj", mimeType: "image/png" }]);
});

test("ACP runtime exposes native identity and starts stopped", async () => {
  const runtime = new AcpRuntimeSession({ executable: "unused", cwd: process.cwd(), model: "raw-model-id", mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
  assert.equal(runtime.driver, "acp");
  assert.equal(runtime.isRunning, false);
  await runtime.abort();
});

for (const systemPrompt of [undefined, "", "Pi instructions"]) {
  test(`ACP runtime instruction identity: ${JSON.stringify(systemPrompt)}`, async () => {
    const runtime = new AcpRuntimeSession({ executable: "unused", cwd: process.cwd(), model: "raw-model-id", ...(systemPrompt === undefined ? {} : { systemPrompt }), mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
    assert.equal(runtime.instructionKey, systemPrompt === undefined ? undefined : fingerprintAcpSystemPrompt(JSON.stringify([process.cwd(), systemPrompt])));
    await runtime.abort();
  });
}

test("ACP context omits all system updates but preserves history", () => {
  const user = { role: "user" as const, content: "historical input", timestamp: 0 };
  const result = { role: "toolResult" as const, toolCallId: "call", toolName: "read", content: [{ type: "text" as const, text: "untrusted result" }], isError: false, timestamp: 1 };
  assert.deepEqual(acpContext([
    { role: "system", content: "base", timestamp: 0 }, user,
    { role: "system", content: "update", timestamp: 1 }, result,
  ]), acpContext([user, result]));
});

test("ACP persisted identity distinguishes workspaces with identical instructions", async (t) => {
  const runtimes = ["/workspace/one", "/workspace/two"].map((cwd) =>
    new AcpRuntimeSession({ executable: "unused", cwd, model: "raw", systemPrompt: "same instructions", mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } }));
  t.after(() => Promise.all(runtimes.map((runtime) => runtime.abort())));

  assert.notEqual(runtimes[0]!.instructionKey, runtimes[1]!.instructionKey);
});
