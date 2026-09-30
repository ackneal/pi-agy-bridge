import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { AgyProcess } from "./process.ts";
import { AgyProcessError } from "../shared/types.ts";

describe("AgyProcess", () => {
  it("starts agy with stream-json input and output", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-test-"));
    const executable = path.join(tempDir, "agy");
    const argsFile = path.join(tempDir, "args.json");
    const script = `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ event: "init" }) + "\\n");
process.stdin.resume();
`;

    await writeFile(executable, script, "utf-8");
    await chmod(executable, 0o755);

    const proc = new AgyProcess({
      agyPath: executable,
      agentName: "pi-test",
      model: "gemini-3.8-flash-high",
    });

    try {
      await proc.start();
      const args = JSON.parse(await readFile(argsFile, "utf-8")) as string[];

      assert.equal(args.some((arg) => arg.startsWith("--print")), false);
      assert.deepEqual(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 4), [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ]);
    } finally {
      await proc.abort();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sends multiple stream-json inputs through one process and exposes events", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-reuse-"));
    const executable = path.join(tempDir, "agy");
    const script = `#!${process.execPath}
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ event: "init" }) + "\\n");
lines.on("line", (line) => {
  const input = JSON.parse(line);
  process.stdout.write(JSON.stringify({ event: "step_update", text_delta: input.message.content }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", status: "success" }) + "\\n");
});
`;
    await writeFile(executable, script, "utf-8");
    await chmod(executable, 0o755);

    const proc = new AgyProcess({ agyPath: executable, agentName: "pi-test", model: "test" });
    try {
      await proc.start();
      const events = proc.events()[Symbol.asyncIterator]();
      for (const prompt of ["first", "second"]) {
        await proc.send({ event: "user", message: { content: prompt } });
        const received: string[] = [];
        while (true) {
          const { value, done } = await events.next();
          assert.equal(done, false);
          if (value?.event === "step_update" && typeof value.text_delta === "string") {
            received.push(value.text_delta);
          }
          if (value?.event === "result") break;
        }
        assert.deepEqual(received, [prompt]);
      }
      await events.return?.();
    } finally {
      await proc.abort();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("abort() handles an unstarted process safely", async () => {
    const proc = new AgyProcess({
      agentName: "pi-test",
      model: "gemini-3.8-flash-high",
    });

    await proc.abort();
    assert.equal(proc.isRunning, false);
  });

  it("send() throws when process is not running", async () => {
    const proc = new AgyProcess({
      agentName: "pi-test",
      model: "gemini-3.8-flash-high",
    });

    await assert.rejects(
      async () => proc.send({ event: "user", message: { content: "Hello" } }),
      (err: any) => {
        assert.equal(err instanceof AgyProcessError, true);
        return true;
      }
    );
  });

  it("caps captured stderr from the child process", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-stderr-"));
    const executable = path.join(tempDir, "agy");
    const script = `#!${process.execPath}
process.stderr.write("X".repeat(40000));
process.exit(1);
`;
    await writeFile(executable, script, "utf-8");
    await chmod(executable, 0o755);

    const proc = new AgyProcess({ agyPath: executable, agentName: "pi-test", model: "test" });
    try {
      await assert.rejects(proc.start(), (error: unknown) => {
        assert.ok(error instanceof AgyProcessError);
        assert.equal(error.stderr?.length, 32768);
        return true;
      });
    } finally {
      await proc.abort();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes environment variables when environment option is provided", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-process-env-"));
    const executable = path.join(tempDir, "agy");
    const recordedFile = path.join(tempDir, "recorded.json");
    const script = `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(recordedFile)}, JSON.stringify({
  args: process.argv.slice(2),
  mcpCommand: process.env.PI_AGY_BRIDGE_MCP_COMMAND,
}));
process.stdout.write(JSON.stringify({ event: "init" }) + "\\n");
process.stdin.resume();
`;

    await writeFile(executable, script, "utf-8");
    await chmod(executable, 0o755);

    const proc = new AgyProcess({
      agyPath: executable,
      agentName: "pi-test",
      model: "gemini-3.8-flash-high",
      conversationId: "conversation-1",
      environment: {
        PI_AGY_BRIDGE_MCP_COMMAND: "node mcp-server.js --endpoint unix:///tmp/pi-agy.sock?session=session-1",
      },
    });

    try {
      await proc.start();
      const recorded = JSON.parse(await readFile(recordedFile, "utf-8")) as {
        args: string[];
        mcpCommand?: string;
      };
      assert.deepEqual(recorded.args.slice(recorded.args.indexOf("--conversation"), recorded.args.indexOf("--conversation") + 2), [
        "--conversation",
        "conversation-1",
      ]);
      assert.equal(recorded.mcpCommand, "node mcp-server.js --endpoint unix:///tmp/pi-agy.sock?session=session-1");
    } finally {
      await proc.abort();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
