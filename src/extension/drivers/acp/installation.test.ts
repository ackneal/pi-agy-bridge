import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { writeZipFixture, type ZipFixtureEntry } from "./archive-fixture.ts";
import { ensureAcpInstallation, type AcpInstallProgress } from "./installation.ts";
import { acpDistributionName, resolveAcpRelease, type AcpRelease } from "./release.ts";

const contents: ZipFixtureEntry[] = [
  { name: "agy_acp_server.par", data: "not a real ACP executable\n", mode: 0o100755 },
  { name: "localharness_external", data: "companion executable\n", mode: 0o100555 },
  { name: "resources/", mode: 0o040755 },
  { name: "resources/.data", data: "preserve complete distribution" },
];
const archiveUrl = "https://fixture.invalid/agy-acp-server-1.4.3-linux-x86_64.zip";

async function fixture(t: TestContext, entries = contents) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acp-install-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const archive = path.join(home, "fixture.zip");
  await writeZipFixture(archive, entries);
  const bytes = await fs.readFile(archive);
  const release = { ...resolveAcpRelease("linux", "x64"), sha256: createHash("sha256").update(bytes).digest("hex"), url: archiveUrl };
  let downloads = 0;
  const fetcher: typeof fetch = async () => {
    downloads++;
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  };
  const root = path.join(await fs.realpath(home), "pi-agy-bridge", "acp");
  return { home, bytes, release, root, fetcher, downloads: () => downloads };
}

async function launchFixture(home: string, release: AcpRelease, archivePath: string, mode?: "barrier" | "partial" | "offline") {
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./installation-fixture.ts", import.meta.url)), home, JSON.stringify(release), JSON.stringify({ archivePath, mode })], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let downloaded!: () => void;
  let partial!: () => void;
  const downloading = new Promise<void>((resolve) => { downloaded = resolve; });
  const streaming = new Promise<void>((resolve) => { partial = resolve; });
  child.on("message", (message: { type?: string }) => {
    if (message.type === "download") downloaded();
    if (message.type === "partial") partial();
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
  const result = new Promise<{ executable: string; args: string[] }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`Fixture exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, result, downloading, streaming };
}

for (const scenario of ["installation", "cache reuse", "missing metadata", "broken metadata", "modified file", "missing companion", "lost permission", "partial published directory", "empty published directory", "partial staging"] as const) {
  test(`ACP installation: ${scenario}`, async (t) => {
    const f = await fixture(t);
    const events: AcpInstallProgress[] = [];
    const initial = await ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: f.fetcher, onProgress: (event) => events.push(event) });
    const finalDirectory = path.join(f.root, acpDistributionName(f.release));
    const inode = (await fs.stat(finalDirectory)).ino;
    assert.equal(path.dirname(initial.executable), finalDirectory);
    if (scenario === "installation") {
      assert.equal(await fs.readFile(initial.executable, "utf8"), contents[0]!.data);
      assert.equal(await fs.readFile(path.join(finalDirectory, "resources/.data"), "utf8"), contents[3]!.data);
      assert.equal((await fs.stat(path.join(finalDirectory, "localharness_external"))).mode & 0o777, 0o555);
      assert.deepEqual(initial.args, ["--uid="]);
      assert.deepEqual([...new Set(events.map((event) => event.phase))], ["download", "verify", "extract", "validate", "complete"]);
      assert.ok(events.some((event) => event.phase === "download" && event.downloadedBytes === f.bytes.length && event.totalBytes === f.bytes.length));
      assert.equal(f.downloads(), 1);
      await fs.mkdir(path.join(f.home, "pi-agy-bridge"), { recursive: true });
      await fs.writeFile(path.join(f.home, "pi-agy-bridge", "settings"), "preserve me");
      await ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: async () => { throw new Error("Network must not be used"); } });
      assert.equal(await fs.readFile(path.join(f.home, "pi-agy-bridge", "settings"), "utf8"), "preserve me");
      return;
    }
    if (scenario === "missing metadata") await fs.rm(path.join(finalDirectory, ".pi-agy-installation.json"));
    if (scenario === "broken metadata") await fs.writeFile(path.join(finalDirectory, ".pi-agy-installation.json"), "not json");
    if (scenario === "modified file") await fs.writeFile(initial.executable, "corrupted binary\n");
    if (scenario === "missing companion") await fs.rm(path.join(finalDirectory, "localharness_external"));
    if (scenario === "lost permission") await fs.chmod(initial.executable, 0o644);
    if (scenario === "empty published directory") {
      for (const name of await fs.readdir(finalDirectory)) await fs.rm(path.join(finalDirectory, name), { recursive: true, force: true });
    }
    if (scenario === "partial staging" || scenario === "partial published directory") {
      const directory = scenario === "partial staging" ? path.join(f.root, ".staging-abandoned") : finalDirectory;
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "agy_acp_server.par"), "partial download");
    }
    const repair = ["modified file", "missing companion", "lost permission", "missing metadata", "broken metadata", "partial published directory", "empty published directory"].includes(scenario);
    const fetcher: typeof fetch = repair ? f.fetcher : async () => { throw new Error("Network must not be used"); };
    const recovered = await ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: fetcher });
    assert.equal(await fs.readFile(recovered.executable, "utf8"), contents[0]!.data);
    assert.equal(f.downloads(), repair ? 2 : 1);
    assert.equal(recovered.executable, initial.executable);
    assert.equal((await fs.stat(finalDirectory)).ino, inode);
    assert.ok((await fs.stat(path.join(finalDirectory, "localharness_external"))).mode & 0o111);
  });
}

for (const scenario of ["checksum mismatch", "invalid ZIP", "missing required file", "non-executable companion", "HTTP failure", "root symlink"] as const) {
  test(`ACP installation failure: ${scenario}`, async (t) => {
    const entries = scenario === "missing required file" ? contents.slice(0, 1) : scenario === "non-executable companion" ? contents.map((entry) => entry.name === "localharness_external" ? { ...entry, mode: 0o100644 } : entry) : contents;
    const f = await fixture(t, entries);
    let release = f.release;
    let fetcher = f.fetcher;
    const expected = { "checksum mismatch": /SHA-256 mismatch.*expected/s, "invalid ZIP": /end of central directory|signature|zipfile|not found/i, "missing required file": /missing required executable localharness_external/, "non-executable companion": /missing required executable localharness_external/, "HTTP failure": /HTTP 503/, "root symlink": /not a symlink/ }[scenario];
    if (scenario === "checksum mismatch") release = { ...release, sha256: "0".repeat(64) };
    if (scenario === "invalid ZIP") {
      const bytes = Buffer.from("this archive has a correct hash but is not ZIP");
      release = { ...release, sha256: createHash("sha256").update(bytes).digest("hex") };
      fetcher = async () => new Response(bytes);
    }
    if (scenario === "HTTP failure") fetcher = async () => new Response("unavailable", { status: 503 });
    if (scenario === "root symlink") {
      const elsewhere = path.join(f.home, "elsewhere");
      await fs.mkdir(elsewhere);
      await fs.mkdir(path.dirname(f.root), { recursive: true });
      await fs.symlink(elsewhere, f.root);
    }
    const events: AcpInstallProgress[] = [];
    await assert.rejects(ensureAcpInstallation({ agentHome: f.home, release, fetch: fetcher, onProgress: (event) => events.push(event) }), expected);
    assert.equal(events.at(-1)?.phase, "error");
    if (scenario === "checksum mismatch") assert.ok(!events.some((event) => event.phase === "extract"));
    if (scenario !== "root symlink") {
      const goodArchive = path.join(f.home, "good.zip");
      await writeZipFixture(goodArchive, contents);
      const goodBytes = await fs.readFile(goodArchive);
      const goodRelease = { ...f.release, sha256: createHash("sha256").update(goodBytes).digest("hex") };
      const recovered = await ensureAcpInstallation({ agentHome: f.home, release: goodRelease, fetch: async () => new Response(goodBytes) });
      assert.equal(await fs.readFile(recovered.executable, "utf8"), contents[0]!.data);
    }
  });
}

test("publication corruption is rejected and repaired on the next call", async (t) => {
  const f = await fixture(t);
  const originalRename = fs.rename;
  let mutated = false;
  fs.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (!mutated && path.basename(String(source)) === "distribution") {
      mutated = true;
      await fs.writeFile(path.join(String(destination), "agy_acp_server.par"), "corrupted after publication");
    }
  };
  try {
    await assert.rejects(ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: f.fetcher }), /integrity validation/);
  } finally {
    fs.rename = originalRename;
  }
  const repaired = await ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: f.fetcher });
  assert.equal(await fs.readFile(repaired.executable, "utf8"), contents[0]!.data);
  assert.equal(f.downloads(), 2);
});

test("same-process ACP consumers share progress and cancellation does not cancel another consumer", async (t) => {
  const f = await fixture(t);
  const cancelled = new AbortController();
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  t.after(resume);
  let downloads = 0;
  const fetcher: typeof fetch = async () => { downloads++; entered(); await gate; return new Response(f.bytes); };
  const a: AcpInstallProgress[] = [];
  const b: AcpInstallProgress[] = [];
  const first = ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: fetcher, signal: cancelled.signal, onProgress: (event) => a.push(event) });
  const rejection = assert.rejects(first, /cancel this consumer/);
  await started;
  const second = ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: fetcher, onProgress: (event) => b.push(event) });
  cancelled.abort(new Error("cancel this consumer"));
  await rejection;
  resume();
  const launch = await second;
  assert.equal(downloads, 1);
  assert.equal(await fs.readFile(launch.executable, "utf8"), contents[0]!.data);
  assert.ok(!a.some((event) => event.phase === "complete" || event.phase === "error"));
  assert.equal(b[0]?.phase, "download");
  assert.equal(b.at(-1)?.phase, "complete");
});

for (const scenario of ["different pin", "unexpected file"] as const) {
  test(`stable installation refuses unsafe replacement: ${scenario}`, async (t) => {
    const f = await fixture(t);
    const initial = await ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: f.fetcher });
    const directory = path.dirname(initial.executable);
    let release = f.release;
    let fetcher = f.fetcher;
    if (scenario === "different pin") {
      const archive = path.join(f.home, "changed.zip");
      await writeZipFixture(archive, contents.map((entry) => entry.name === "agy_acp_server.par" ? { ...entry, data: "different release bytes" } : entry));
      const bytes = await fs.readFile(archive);
      release = { ...release, sha256: createHash("sha256").update(bytes).digest("hex") };
      fetcher = async () => new Response(bytes);
    } else {
      await fs.writeFile(path.join(directory, "unrecognized-data"), "must not be deleted");
    }

    await assert.rejects(ensureAcpInstallation({ agentHome: f.home, release, fetch: fetcher }),
      scenario === "different pin" ? /different pinned archive/ : /damaged or unexpected files/);

    assert.equal(await fs.readFile(initial.executable, "utf8"), contents[0]!.data);
    if (scenario === "unexpected file") assert.equal(await fs.readFile(path.join(directory, "unrecognized-data"), "utf8"), "must not be deleted");
  });
}

for (const scenario of ["first install", "repair"] as const) {
  test(`concurrent Pi processes reuse the same stable path: ${scenario}`, async (t) => {
    const f = await fixture(t);
    const finalDirectory = path.join(f.root, acpDistributionName(f.release));
    if (scenario === "repair") {
      const first = await ensureAcpInstallation({ agentHome: f.home, release: f.release, fetch: f.fetcher });
      await fs.rm(path.join(finalDirectory, "localharness_external"));
      assert.equal(path.dirname(first.executable), finalDirectory);
    }
    const inode = scenario === "repair" ? (await fs.stat(finalDirectory)).ino : undefined;
    const release = f.release;
    const runs = await Promise.all([launchFixture(f.home, release, path.join(f.home, "fixture.zip"), "barrier"), launchFixture(f.home, release, path.join(f.home, "fixture.zip"), "barrier")]);
    t.after(() => { for (const run of runs) run.child.kill("SIGKILL"); });
    await Promise.all(runs.map((run) => Promise.race([run.downloading, run.result.then(() => { throw new Error("Installer did not reach download barrier"); })])));
    for (const run of runs) run.child.send("continue");
    const launches = await Promise.all(runs.map((run) => run.result));
    if (inode !== undefined) assert.equal((await fs.stat(finalDirectory)).ino, inode);
    assert.equal(launches[0]!.executable, launches[1]!.executable);
    assert.equal(launches[0]!.executable, path.join(finalDirectory, "agy_acp_server.par"));
    assert.equal((await fs.readdir(f.root)).filter((name) => !name.startsWith(".staging-")).length, 1);
    const offline = await launchFixture(f.home, release, path.join(f.home, "fixture.zip"), "offline");
    assert.equal((await offline.result).executable, launches[0]!.executable);
  });
}

test("a killed installer leaves no published partial install and the next Pi process recovers", async (t) => {
  const f = await fixture(t);
  const release = f.release;
  const archivePath = path.join(f.home, "fixture.zip");
  const interrupted = await launchFixture(f.home, release, archivePath, "partial");
  const rejected = assert.rejects(interrupted.result, /SIGKILL/);
  t.after(() => interrupted.child.kill("SIGKILL"));
  await Promise.race([interrupted.streaming, interrupted.result.then(() => { throw new Error("Installer did not begin partial download"); })]);
  const deadline = Date.now() + 5000;
  let written = false;
  while (!written && Date.now() < deadline) {
    for (const name of await fs.readdir(f.root)) {
      if (!name.startsWith(".staging-")) continue;
      const file = await fs.stat(path.join(f.root, name, "archive.zip")).catch(() => undefined);
      if (file && file.size > 0) written = true;
    }
    if (!written) await delay(5);
  }
  assert.ok(written, "installer wrote a partial archive before being killed");
  interrupted.child.kill("SIGKILL");
  await rejected;
  await assert.rejects(fs.access(path.join(f.root, acpDistributionName(release))));
  const next = await launchFixture(f.home, release, archivePath);
  const recovered = await next.result;
  assert.equal(await fs.readFile(recovered.executable, "utf8"), contents[0]!.data);
});
