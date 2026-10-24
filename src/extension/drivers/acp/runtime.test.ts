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
