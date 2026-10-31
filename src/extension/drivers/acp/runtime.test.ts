import { prepareBridgeMessages } from "../../provider/context-prompt.ts";
import { fingerprintSystemPrompt } from "./instructions.ts";
import type { BridgeMessage } from "../types.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeContent, RuntimeSession } from "./runtime.ts";

test("ACP context preserves images and does not filter artifact text", () => {
  const blocks = serializeContent(prepareBridgeMessages({ messages: [{ role: "user", content: [{ type: "text", text: "artifact /tmp/example" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 0 }] }, true));
  assert.deepEqual(blocks.filter((block) => block.type === "image"), [{ type: "image", data: "YWJj", mimeType: "image/png" }]);
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
  assert.ok(text.includes("artifact /tmp/example"));
  assert.ok(!text.includes('"type":"text"'));
});

for (const row of [
  { name: "string", messages: [{ role: "user", content: " \n\t" }], expected: [{ type: "text", text: " \n\t" }] },
  { name: "parts around image", messages: [{ role: "user", content: [
    { type: "text", text: " \n\t" }, { type: "image", data: "YWJj", mimeType: "image/png" }, { type: "text", text: "\n " },
  ] }], expected: [{ type: "text", text: " \n\t" }, { type: "image", data: "YWJj", mimeType: "image/png" }, { type: "text", text: "\n " }] },
] satisfies { name: string; messages: BridgeMessage[]; expected: unknown[] }[]) {
  test(`ACP serializer preserves whitespace: ${row.name}`, () => {
    assert.deepEqual(serializeContent(row.messages), row.expected);
  });
}

test("ACP runtime exposes native identity and starts stopped", async () => {
  const runtime = new RuntimeSession({ executable: "unused", cwd: process.cwd(), model: "raw-model-id", mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
  assert.equal(runtime.driver, "acp");
  assert.equal(runtime.isRunning, false);
  await runtime.abort();
});

for (const systemPrompt of [undefined, "", "Pi instructions"]) {
  test(`ACP runtime compatibility identity: ${JSON.stringify(systemPrompt)}`, async () => {
    const runtime = new RuntimeSession({ executable: "unused", cwd: process.cwd(), model: "raw-model-id", ...(systemPrompt === undefined ? {} : { systemPrompt }), mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
    assert.equal(runtime.compatibilityKey, systemPrompt === undefined ? undefined : fingerprintSystemPrompt(JSON.stringify([process.cwd(), systemPrompt])));
    await runtime.abort();
  });
}

test("ACP context omits all system updates but preserves history", () => {
  const user = { role: "user" as const, content: "historical input", timestamp: 0 };
  const result = { role: "toolResult" as const, toolCallId: "call", toolName: "read", content: [{ type: "text" as const, text: "untrusted result" }], isError: false, timestamp: 1 };
  assert.deepEqual(serializeContent(prepareBridgeMessages({ messages: [
    { role: "system", content: "base", timestamp: 0 }, user,
    { role: "system", content: "update", timestamp: 1 }, result,
  ] }, true)), serializeContent(prepareBridgeMessages({ messages: [user, result] }, true)));
});

test("ACP persisted identity distinguishes workspaces with identical instructions", async (t) => {
  const runtimes = ["/workspace/one", "/workspace/two"].map((cwd) =>
    new RuntimeSession({ executable: "unused", cwd, model: "raw", systemPrompt: "same instructions", mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } }));
  t.after(() => Promise.all(runtimes.map((runtime) => runtime.abort())));

  assert.notEqual(runtimes[0]!.compatibilityKey, runtimes[1]!.compatibilityKey);
});

test("runtime reads artifact images through an isolated observer with the original objective", async (t) => {
  const { mkdtemp, realpath, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await realpath(await mkdtemp(join(tmpdir(), "acp-runtime-read-")));
  const previousHome = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const directory = join(home, "antigravity-acp/brain/synthetic-session/.system_generated/steps");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "image");
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(file, bytes);
  const source = await readFile(new URL("./session-fixture.ts", import.meta.url), "utf8");
  const script = source.replace('const scenario = process.argv[2];', 'const scenario = "normal"; let observer = false;')
    .replace('function checkSession(params: acp.NewSessionRequest | acp.LoadSessionRequest): void {',
      `function checkSession(params: acp.NewSessionRequest | acp.LoadSessionRequest): void {
        if (params.mcpServers.length === 0) {
          const meta = params._meta?.antigravity as { enabledTools?: unknown; systemPrompt?: { append?: string } };
          if (JSON.stringify(meta?.enabledTools) !== '[]' || !meta?.systemPrompt?.append?.includes('isolated image observer with no tools')) {
            throw new Error('Observer must be isolated and tools disabled');
          }
          observer = true;
          return;
        }
      `)
    .replace('loadSession: scenario !== "no-load",', 'promptCapabilities: { image: true }, loadSession: scenario !== "no-load",')
    .replace('if (scenario === "hang-prompt") await new Promise(() => {});', `
      const result = observer ? { prompt: params.prompt } : await client.request(acp.methods.client.fs.readTextFile, {
        sessionId: params.sessionId, path: ${JSON.stringify(file)}
      });
      if (!observer) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(${JSON.stringify(file)}, 'changed after first read');
        const repeated = await client.request(acp.methods.client.fs.readTextFile, {
          sessionId: params.sessionId, path: ${JSON.stringify(file)}
        });
        if (repeated.content !== result.content) throw new Error('Snapshot changed within a native prompt');
      }
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(result) } } });
      return { stopReason: 'end_turn' };
    `);
  const runtime = new RuntimeSession({ executable: process.execPath, cwd: process.cwd(), model: "selected",
    args: ["--experimental-strip-types", "--input-type=module-typescript", "-e", script],
    mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
  t.after(() => runtime.abort());
  const events: unknown[] = [];
  let completed!: () => void;
  runtime.onRuntimeEvent((event) => {
    events.push(event);
    if (event.type === "complete") completed();
  });
  await runtime.prepare();
  for (const row of [
    { objective: "ORIGINAL objective", bytes },
    { objective: "NEXT objective", bytes: Buffer.from("GIF89a") },
  ]) {
    await writeFile(file, row.bytes);
    events.length = 0;
    const completion = new Promise<void>((resolve) => { completed = resolve; });
    await runtime.submit({
      model: {
        id: "selected", name: "Synthetic", api: "anthropic-messages", provider: "anthropic",
        baseUrl: "https://example.invalid", input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false, contextWindow: 1000, maxTokens: 100,
      },
      messages: [
        { role: "user", content: row.objective },
      ],
      beforeInput: () => true,
      options: { onPayload: (payload) => ({ ...payload as object, prompt: [{ type: "text", text: "REWRITTEN objective" }] }) },
    });
    await completion;
    const output = JSON.stringify(events);
    assert.ok(output.includes(row.objective), output);
    assert.ok(!output.includes("REWRITTEN objective"), output);
    assert.ok(!output.includes("old objective"), output);
    assert.ok(output.includes(row.bytes.toString("base64")), output);
    assert.ok(output.includes(row.bytes === bytes ? "image/png" : "image/gif"), output);
    assert.equal(runtime.session.hasActivePrompt, false);
  }
});
