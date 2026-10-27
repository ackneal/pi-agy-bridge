import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DriverSubmission, RuntimeEvent } from "../types.ts";
import { AcpRuntimeSession } from "./runtime.ts";

for (const row of [
  { name: "callback before announcement", announceFirst: false, outside: false },
  { name: "announcement before callback", announceFirst: true, outside: false },
  { name: "client route does not authorize an outside path", announceFirst: false, outside: true },
]) {
  test(`client tool notification: ${row.name}`, { timeout: 10000 }, async (t) => {
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
            kind: "read", status: "in_progress", rawInput: { absolute_path: ${JSON.stringify(target)} } },
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
    const runtime = new AcpRuntimeSession({ executable: process.execPath, cwd: process.cwd(), model: "selected",
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
    await runtime.submit({ model: { id: "selected" }, context: { messages: [{ role: "user", content: "Read the artifact", timestamp: 0 }] },
      options: undefined, reconstructContext: true, syncedMessageCount: 0, beforeInput: () => true,
    } as DriverSubmission);
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
