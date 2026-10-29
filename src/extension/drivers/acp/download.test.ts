import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureAcpInstallation } from "./installation.ts";
import type { DriverInstallationProgress } from "../types.ts";
import { acpDistributionName, resolveAcpRelease } from "./release.ts";
import { writeZipFixture } from "./archive-fixture.ts";

for (const scenario of ["interrupted body", "stalled headers", "cancelled download"] as const) {
  test(`ACP download recovery: ${scenario}`, async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-download-"));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const archive = path.join(home, "fixture.zip");
    await writeZipFixture(archive, [
      { name: "agy_acp_server.par", data: "fixture", mode: 0o100755 },
      { name: "localharness_external", data: "companion", mode: 0o100555 },
    ]);
    const bytes = await fs.readFile(archive);
    const release = { ...resolveAcpRelease(), sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://fixture.invalid/agy-acp-server-1.4.3-linux-x86_64.zip" };
    const root = path.join(await fs.realpath(home), "pi-agy-bridge", "acp");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const controller = new AbortController();
    const events: DriverInstallationProgress[] = [];
    const fetcher: typeof fetch = async (_url, options) => {
      assert.equal(options?.redirect, "error");
      entered();
      if (scenario === "interrupted body") return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(bytes.subarray(0, 8));
        stream.error(new Error("connection interrupted"));
      } }));
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    };
    if (scenario === "stalled headers") t.mock.timers.enable({ apis: ["setTimeout"] });
    const attempt = ensureAcpInstallation({ agentHome: home, release, fetch: fetcher, signal: controller.signal, onProgress: (event) => events.push(event) });
    const rejected = assert.rejects(attempt, scenario === "interrupted body" ? /connection interrupted/ : scenario === "stalled headers" ? /stalled for 60 seconds/ : /cancel download/);
    await started;
    if (scenario === "stalled headers") t.mock.timers.tick(60_000);
    if (scenario === "cancelled download") controller.abort(new Error("cancel download"));
    await rejected;
    if (scenario === "stalled headers") t.mock.timers.reset();
    assert.equal(events.at(-1)?.phase, scenario === "cancelled download" ? "cancelled" : "error");
    assert.ok(!events.some((event) => event.phase === "extract"));
    await assert.rejects(fs.access(path.join(root, acpDistributionName(release))));
    const next = await ensureAcpInstallation({ agentHome: home, release, fetch: async () => new Response(bytes) });
    assert.equal(await fs.readFile(next.executable, "utf8"), "fixture");
  });
}
