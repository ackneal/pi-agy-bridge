import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { AcpConnection } from "./connection.ts";

const [mode, childPidFile, agentPidFile] = process.argv.slice(2);
if (!mode || !childPidFile || !agentPidFile) throw new Error("Expected host-exit scenario and synthetic PID files");
const connection = new AcpConnection({
  executable: process.execPath,
  cwd: process.cwd(),
  args: ["--experimental-strip-types", fileURLToPath(new URL("./connection-fixture.ts", import.meta.url)),
    mode === "leader-exited" ? "descendant-exit" : "descendant", childPidFile, agentPidFile],
  requestTimeoutMs: 2000,
});

try {
  await connection.start();
  for (let attempt = 0; ; attempt++) {
    let pid = 0;
    try { pid = Number(await readFile(childPidFile, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Number.isInteger(pid) && pid > 1) break;
    if (attempt >= 100) throw new Error("Synthetic descendant did not publish its PID");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  if (mode === "stopping") void connection.dispose();
  if (mode === "leader-exited") {
    try {
      await connection.request(acp.methods.agent.session.prompt, {
        sessionId: "synthetic", prompt: [{ type: "text", text: "exit the synthetic ACP leader" }],
      });
      throw new Error("Expected synthetic ACP leader to exit");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("closed")) throw error;
    }
  }
  process.exit(0);
} catch (error) {
  await connection.dispose();
  throw error;
}
