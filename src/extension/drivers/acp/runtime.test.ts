import { prepareBridgeMessages } from "../../provider/context-prompt.ts";
import { fingerprintSystemPrompt } from "./instructions.ts";
import type { BridgeMessage, DriverSubmission, RuntimeEvent } from "../types.ts";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { serializeContent, RuntimeSession } from "./runtime.ts";

describe("serializeContent and RuntimeSession identity", () => {
  test("ACP context preserves images and does not filter artifact text", () => {
    const blocks = serializeContent(prepareBridgeMessages({ messages: [{ role: "user", content: [{ type: "text", text: "artifact /tmp/example" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 0 }] }, true));
    assert.deepEqual(blocks.filter((block) => block.type === "image"), [{ type: "image", data: "YWJj", mimeType: "image/png" }]);
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
    assert.ok(text.includes("artifact /tmp/example"));
    assert.ok(!text.includes('"type":"text"'));
  });

  for (const row of [
    { name: "preserves a whitespace-only string", messages: [{ role: "user", content: " \n\t" }], expected: [{ type: "text", text: " \n\t" }] },
    { name: "preserves whitespace parts around an image", messages: [{ role: "user", content: [
      { type: "text", text: " \n\t" }, { type: "image", data: "YWJj", mimeType: "image/png" }, { type: "text", text: "\n " },
    ] }], expected: [{ type: "text", text: " \n\t" }, { type: "image", data: "YWJj", mimeType: "image/png" }, { type: "text", text: "\n " }] },
  ] satisfies { name: string; messages: BridgeMessage[]; expected: unknown[] }[]) {
    test(`serializeContent preserves whitespace: ${row.name}`, () => {
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
    test(`RuntimeSession fingerprints workspace and supplied system prompt: ${JSON.stringify(systemPrompt)}`, async () => {
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
});

describe("RuntimeSession conditional transcript usage", () => {
  for (const row of [
    { name: "newer step at the prompt start second is fresh", priorStep: 4, step: 5, offset: 0, fresh: true },
    { name: "newer step inside the prompt interval is fresh", priorStep: 4, step: 5, offset: 500, fresh: true },
    { name: "newer step after prompt completion is not fresh", priorStep: 4, step: 5, offset: 1000, fresh: false },
    { name: "first snapshot is fresh without a prior transcript", step: 0, offset: 0, fresh: true },
    { name: "unchanged step is stale despite a current timestamp", priorStep: 5, step: 5, offset: 0, fresh: false },
    { name: "lower step is stale despite a current timestamp", priorStep: 5, step: 4, offset: 0, fresh: false },
    { name: "newer step before the start second is stale", priorStep: 4, step: 5, offset: -1, fresh: false },
    { name: "old first snapshot is stale without a prior transcript", step: 5, offset: -1, fresh: false },
    { name: "missing transcript leaves accounting available", fresh: false },
    { name: "missing post-response transcript cannot reuse prior usage", priorStep: 4, fresh: false },
    { name: "cancelled response cannot use a fresh snapshot", priorStep: 4, step: 5, offset: 0, stopReason: "cancelled", fresh: false },
    { name: "refused response cannot use a fresh snapshot", priorStep: 4, step: 5, offset: 0, stopReason: "refusal", fresh: false },
  ] satisfies { name: string; priorStep?: number; step?: number; offset?: number; stopReason?: "cancelled" | "refusal"; fresh: boolean }[]) {
    test(row.name, { timeout: 10000 }, async (t) => {
      const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const home = await mkdtemp(join(tmpdir(), "acp-runtime-usage-"));
      const previousHome = process.env.GEMINI_HOME;
      process.env.GEMINI_HOME = home;
      t.after(async () => {
        if (previousHome === undefined) delete process.env.GEMINI_HOME;
        else process.env.GEMINI_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
      });
      const runtime = new RuntimeSession({ executable: process.execPath, cwd: process.cwd(), model: "selected",
        args: ["--experimental-strip-types", fileURLToPath(new URL("./session-fixture.ts", import.meta.url)), "normal"],
        mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
      t.after(() => runtime.abort());
      await runtime.prepare();

      const startedAt = Date.parse("2026-11-09T14:31:54Z");
      t.mock.method(Date, "now", () => startedAt + 750);
      const filename = join(home, "antigravity-acp", "brain", runtime.session.id, ".system_generated/logs/transcript.jsonl");
      await mkdir(dirname(filename), { recursive: true });
      const transcript = (step: number, timestamp: number) => JSON.stringify({
        source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", step_index: step,
        created_at: new Date(timestamp).toISOString(), input_tokens: 10000, output_tokens: 1228,
        cache_read_tokens: 53000, cache_write_tokens: 12,
      }) + "\n";
      if (row.priorStep !== undefined) await writeFile(filename, transcript(row.priorStep, startedAt - 10000));
      const stopReason = row.stopReason ?? "end_turn";
      const prompt = t.mock.method(runtime.session, "prompt", async () => {
        if (row.step !== undefined) await writeFile(filename, transcript(row.step, startedAt + (row.offset ?? 0)));
        else await rm(filename, { force: true });
        return { stopReason, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
      });
      const events: RuntimeEvent[] = [];
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => { finish = resolve; });
      runtime.onRuntimeEvent((event) => { events.push(event); if (event.type === "complete") finish(); });

      await runtime.submit({ model: { id: "selected", name: "Synthetic", api: "anthropic-messages", provider: "anthropic",
        baseUrl: "https://example.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false, contextWindow: 1000, maxTokens: 100 }, messages: [{ role: "user", content: "Synthetic prompt" }],
        options: undefined, beforeInput: () => true,
      } satisfies DriverSubmission);
      await completed;

      assert.equal(prompt.mock.callCount(), 1);
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      assert.deepEqual(events.filter((event) => event.type === "accounting"), [{
        type: "accounting", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost },
        ...(row.fresh ? { lastCallUsage: { input: 10000, output: 1228, cacheRead: 53000, cacheWrite: 12, totalTokens: 64240, cost } } : {}),
      }]);
      assert.deepEqual(events.filter((event) => event.type === "complete"), [
        stopReason === "end_turn" ? { type: "complete", reason: "stop", resumable: true }
          : stopReason === "cancelled" ? { type: "complete", reason: "aborted", resumable: false }
            : { type: "complete", reason: "error", error: "ACP prompt stopped: refusal", resumable: false },
      ]);
    });
  }
});

describe("RuntimeSession image observation and client tool routes", () => {
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
        messages: [{ role: "user", content: row.objective }],
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

  for (const row of [
    { name: "callback before announcement", announceFirst: false, outside: false, status: "in_progress" },
    { name: "announcement before callback", announceFirst: true, outside: false, status: "in_progress" },
    { name: "completion before callback", announceFirst: true, outside: false, status: "completed" },
    { name: "failed notification with denied read", announceFirst: true, outside: true, status: "failed" },
    { name: "client route does not authorize an outside path", announceFirst: false, outside: true, status: "in_progress" },
  ]) {
    test(`client tool notification: ${row.name}`, { timeout: 10000 }, async (t) => {
      const { mkdtemp, realpath, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const home = await realpath(await mkdtemp(join(tmpdir(), "acp-tool-route-")));
      const previous = process.env.GEMINI_HOME;
      process.env.GEMINI_HOME = home;
      const directory = join(home, "antigravity-acp/brain/synthetic-session/.system_generated/steps");
      await mkdir(directory, { recursive: true });
      const target = row.outside ? join(home, "outside.txt") : join(directory, "output.txt");
      await writeFile(target, "artifact marker\n");
      const source = await readFile(new URL("./session-fixture.ts", import.meta.url), "utf8");
      const script = source.replace("const scenario = process.argv[2];", 'const scenario = "normal";')
        .replace('if (scenario === "hang-prompt") await new Promise(() => {});', `
          const announce = () => client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: "tool_call", toolCallId: "client-read", title: "Running client_view_file",
              kind: "read", status: ${JSON.stringify(row.status)}, rawInput: { absolute_path: ${JSON.stringify(target)} } },
          });
          if (${row.announceFirst}) await announce();
          let readResult;
          try { readResult = await client.request(acp.methods.client.fs.readTextFile, { sessionId: params.sessionId, path: ${JSON.stringify(target)} }); }
          catch { readResult = { denied: true }; }
          if (!${row.announceFirst}) await announce();
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "client-read", status: "completed" },
          });
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(readResult) } },
          });
        `);
      const runtime = new RuntimeSession({ executable: process.execPath, cwd: process.cwd(), model: "selected",
        args: ["--experimental-strip-types", "--input-type=module-typescript", "-e", script],
        mcp: { command: process.execPath, args: ["unused", "--endpoint", "unused"] } });
      t.after(async () => {
        try { await runtime.abort(); }
        finally {
          if (previous === undefined) delete process.env.GEMINI_HOME;
          else process.env.GEMINI_HOME = previous;
          await rm(home, { recursive: true, force: true });
        }
      });
      const events: RuntimeEvent[] = [];
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => { finish = resolve; });
      runtime.onRuntimeEvent((event) => { events.push(event); if (event.type === "complete") finish(); });
      await runtime.prepare();
      await runtime.submit({ model: { id: "selected", name: "Synthetic", api: "anthropic-messages", provider: "anthropic",
        baseUrl: "https://example.invalid", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false, contextWindow: 1000, maxTokens: 100 }, messages: [{ role: "user", content: "Read the artifact" }],
        options: undefined, beforeInput: () => true,
      } satisfies DriverSubmission);
      await completed;

      assert.equal(events.filter((event) => event.type === "tool-warning").length, 0);
      assert.deepEqual(events.filter((event) => event.type === "complete").map((event) => event.reason), ["stop"]);
      assert.equal(runtime.isRunning, true, "permitted client activity must retain the runtime");
      const text = events.filter((event) => event.type === "text-delta").map((event) => event.delta).join("");
      if (row.outside) {
        assert.ok(text.includes('"denied":true'));
        assert.ok(!text.includes("artifact marker"));
      } else assert.ok(text.includes("artifact marker"));
    });
  }
});
