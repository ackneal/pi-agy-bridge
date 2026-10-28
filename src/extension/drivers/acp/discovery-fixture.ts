import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
const mode = process.argv[2];
let authenticated = false;
const connection = acp.agent()
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    if (params.clientCapabilities?.fs?.readTextFile || params.clientCapabilities?.fs?.writeTextFile || params.clientCapabilities?.terminal) throw new Error("unsafe capabilities");
    return { protocolVersion: acp.PROTOCOL_VERSION, authMethods: mode === "login" || mode === "advertised-auth" ? [{ id: "synthetic-auth", name: "Synthetic" }] : [] };
  })
  .onRequest(acp.methods.agent.authenticate, ({ params }) => {
    if (mode === "advertised-auth") throw new Error("Probe must not authenticate");
    if (params.methodId !== "synthetic-auth") throw new Error("wrong method");
    if (mode === "login" && process.env.BROWSER?.includes("noninteractive-browser.js")) throw new Error("Explicit login must allow the user's browser");
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    if (params.mcpServers.length || JSON.stringify(params._meta) !== JSON.stringify({ antigravity: { enabledTools: [] } })) throw new Error("unsafe session");
    if (mode === "browser" || mode === "fragmented-browser") {
      const command = process.env.BROWSER?.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*") %s$/);
      if (!command) throw new Error("Background authentication has no browser interceptor");
      const browser = spawn(JSON.parse(command[1]!), [JSON.parse(command[2]!), "https://accounts.google.com/synthetic-secret"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      await new Promise<void>((resolve, reject) => {
        browser.once("error", reject);
        browser.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Browser interceptor failed")));
      });
      if (mode === "fragmented-browser") {
        process.stderr.write("Open the following link to authenticate ");
        await new Promise((resolve) => setTimeout(resolve, 10));
        process.stderr.write("the ACP server: https://accounts.google.com/synthetic-secret\n");
      } else {
        process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/synthetic-secret\n");
      }
      await new Promise(() => {});
    }
    if (mode === "hang") await new Promise(() => {});
    if (mode === "required" || (mode === "login" && !authenticated)) throw new acp.RequestError(-32000, "Authentication required");
    if (mode === "failure") throw new acp.RequestError(-32001, "synthetic failure");
    return { sessionId: "synthetic", configOptions: mode === "missing" ? null : [{
      id: "model", name: "Model", type: "select", currentValue: "novel", options: mode === "empty" ? [] : [{ value: "novel", name: "Novel Model" }],
    }, { id: "thinking_level", name: "Thinking", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] }] };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
await connection.closed;
