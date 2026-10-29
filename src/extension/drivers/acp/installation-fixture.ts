import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ensureAcpInstallation } from "./installation.ts";
import type { AcpRelease } from "./release.ts";

const [agentHome, serialized, optionsSerialized] = process.argv.slice(2);
if (!agentHome || !serialized || !optionsSerialized) throw new Error("Installation fixture requires agent home, release, and options");
const release: AcpRelease = JSON.parse(serialized);
const options: { archivePath: string; mode?: "barrier" | "partial" | "offline" | "repair-file" | "repair-manifest" } = JSON.parse(optionsSerialized);
const send = (type: string) => process.send?.({ type });
if (options.mode === "repair-file" || options.mode === "repair-manifest") {
  const rename = fsp.rename;
  fsp.rename = async (source, destination) => {
    const stop = path.basename(String(source)) === (options.mode === "repair-file" ? "agy_acp_server.par" : ".pi-agy-installation.json");
    if (stop && options.mode === "repair-manifest") {
      process.channel?.ref();
      send("paused");
      await new Promise(() => {});
    }
    await rename(source, destination);
    if (stop && options.mode === "repair-file") {
      process.channel?.ref();
      send("paused");
      await new Promise(() => {});
    }
  };
}
const fetcher: typeof fetch = async (_input, init) => {
  send("download");
  if (options.mode === "offline") throw new Error("Unexpected fetch in offline fixture");
  if (options.mode === "barrier") {
    const signal = init?.signal;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { process.off("message", onMessage); signal?.removeEventListener("abort", onAbort); };
      const onMessage = (message: unknown) => { if (message === "continue") { cleanup(); resolve(); } };
      const onAbort = () => { cleanup(); reject(signal?.reason); };
      process.on("message", onMessage);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  const stream = fs.createReadStream(options.archivePath, options.mode === "partial" ? { start: 0, end: 7 } : undefined);
  if (options.mode === "partial") {
    // A pending stream alone does not keep Node alive until the parent's SIGKILL.
    process.channel?.ref();
    const body = new PassThrough();
    stream.on("error", (error) => body.destroy(error));
    stream.pipe(body, { end: false });
    send("partial");
    return new Response(Readable.toWeb(body) as ReadableStream, { headers: { "content-length": String((await fs.promises.stat(options.archivePath)).size) } });
  }
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { "content-length": String((await fs.promises.stat(options.archivePath)).size) } });
};
try {
  const launch = await ensureAcpInstallation({ agentHome, release, fetch: fetcher });
  process.stdout.write(JSON.stringify(launch));
} finally {
  if (process.connected) process.disconnect?.();
}
