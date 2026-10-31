import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { distributionName, resolveRelease } from "./release.ts";

const registry = JSON.parse(readFileSync(new URL("./registry.json", import.meta.url), "utf8")) as {
  id: string;
  version: string;
  distribution: { binary: Record<string, { archive: string; cmd: string; sha256: string; args?: string[] }> };
};

test("resolves pinned official ACP releases by platform and architecture", () => {
  const cases = [
    { platform: "darwin", arch: "arm64", key: "darwin-aarch64" },
    { platform: "darwin", arch: "x64", key: "darwin-x86_64" },
    { platform: "linux", arch: "arm64", key: "linux-aarch64" },
    { platform: "linux", arch: "x64", key: "linux-x86_64" },
  ] as const;

  for (const row of cases) {
    const entry = registry.distribution.binary[row.key]!;
    const release = resolveRelease(row.platform, row.arch);
    assert.deepEqual(release, {
      version: registry.version,
      platform: `${row.platform}-${row.arch}`,
      url: entry.archive,
      sha256: entry.sha256,
      executable: "agy_acp_server.par",
      args: entry.args ?? [],
    });
    assert.notEqual(release.args, entry.args, "callers must not mutate snapshot arguments");
  }
});

const binary = registry.distribution.binary["linux-x86_64"]!;
const withEntry = (entry: unknown) => ({ ...registry, distribution: { binary: { "linux-x86_64": entry } } });

for (const row of [
  {
    name: "uses snapshot command and arguments without hardcoded launch settings",
    snapshot: withEntry({ ...binary, cmd: "./bin/launcher", args: ["--registry-argument"] }),
    expected: { version: registry.version, platform: "linux-x64", url: binary.archive, sha256: binary.sha256, executable: "bin/launcher", args: ["--registry-argument"] },
  },
  { name: "rejects null registry", snapshot: null, error: /Invalid ACP registry/ },
  { name: "rejects wrong agent", snapshot: { ...registry, id: "other-agent" }, error: /Invalid ACP registry/ },
  { name: "rejects missing version", snapshot: { ...registry, version: undefined }, error: /Invalid ACP registry/ },
  { name: "rejects malformed version", snapshot: { ...registry, version: "latest" }, error: /Invalid ACP registry/ },
  { name: "rejects missing binary platform", snapshot: { ...registry, distribution: { binary: {} } }, error: /Invalid ACP registry/ },
  { name: "rejects missing distribution", snapshot: { ...registry, distribution: undefined }, error: /Invalid ACP registry/ },
  { name: "rejects malformed checksum", snapshot: withEntry({ ...binary, sha256: "invalid" }), error: /Invalid ACP registry/ },
  { name: "rejects non-array arguments", snapshot: withEntry({ ...binary, args: "--uid=" }), error: /Invalid ACP registry/ },
  { name: "rejects non-string argument", snapshot: withEntry({ ...binary, args: [1] }), error: /Invalid ACP registry/ },
  { name: "rejects NUL argument", snapshot: withEntry({ ...binary, args: ["bad\0argument"] }), error: /Invalid ACP registry/ },
  { name: "rejects malformed URL", snapshot: withEntry({ ...binary, archive: "not a URL" }), error: /Invalid URL/ },
  { name: "rejects external host", snapshot: withEntry({ ...binary, archive: "https://example.test/server.zip" }), error: /official HTTPS Google/ },
  { name: "rejects HTTP", snapshot: withEntry({ ...binary, archive: binary.archive.replace("https:", "http:") }), error: /official HTTPS Google/ },
  { name: "rejects URL credentials", snapshot: withEntry({ ...binary, archive: binary.archive.replace("https://", "https://user:pass@") }), error: /official HTTPS Google/ },
  { name: "rejects non-ZIP archive", snapshot: withEntry({ ...binary, archive: "https://dl.google.com/server.tar" }), error: /archive filename/ },
  { name: "rejects absolute command", snapshot: withEntry({ ...binary, cmd: "/tmp/server" }), error: /Unsafe ACP registry command/ },
  { name: "rejects parent traversal", snapshot: withEntry({ ...binary, cmd: "./bin/../../server" }), error: /Unsafe ACP registry command/ },
  { name: "rejects backslash command", snapshot: withEntry({ ...binary, cmd: "bin\\server" }), error: /Unsafe ACP registry command/ },
  { name: "rejects empty command", snapshot: withEntry({ ...binary, cmd: "" }), error: /Unsafe ACP registry command/ },
  { name: "rejects NUL command", snapshot: withEntry({ ...binary, cmd: "bad\0server" }), error: /Unsafe ACP registry command/ },
]) {
  test(`ACP registry snapshot: ${row.name}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "acp-registry-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Isolate module-level snapshot loading without exposing a test-only parser API.
    await copyFile(new URL("./release.ts", import.meta.url), path.join(directory, "release.ts"));
    await writeFile(path.join(directory, "registry.json"), JSON.stringify(row.snapshot));
    const isolated = await import(pathToFileURL(path.join(directory, "release.ts")).href) as typeof import("./release.ts");

    if ("error" in row) assert.throws(() => isolated.resolveRelease("linux", "x64"), row.error);
    else assert.deepEqual(isolated.resolveRelease("linux", "x64"), row.expected);
  });
}

test("derives safe distribution names from archive filenames", () => {
  const cases = [
    { url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-arm64.zip", expected: "agy-acp-server-1.4.3-darwin-arm64" },
    { url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-x86_64.zip", expected: "agy-acp-server-1.4.3-darwin-x86_64" },
    { url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-arm64.zip", expected: "agy-acp-server-1.4.3-linux-arm64" },
    { url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-x86_64.zip", expected: "agy-acp-server-1.4.3-linux-x86_64" },
    { url: "https://example.test/archive.zip?download=1", expected: "archive" },
    { url: "https://example.test/%2e%2e/escape.zip", expected: "escape" },
  ];

  for (const row of cases) {
    assert.equal(distributionName({ url: row.url }), row.expected);
  }
});

test("rejects unsafe or non-ZIP archive filenames", () => {
  const cases = [
    "https://example.test/",
    "https://example.test/archive.tar",
    "https://example.test/archive%2Fescape.zip",
    "https://example.test/%2e%2e.zip",
    "https://example.test/?archive.zip",
  ];
  for (const url of cases) assert.throws(() => distributionName({ url }));
});

test("rejects unsupported platform and architecture combinations", () => {
  const cases = [
    { platform: "win32", arch: "x64", message: /AGY_ACP_BIN/ },
    { platform: "freebsd", arch: "x64", message: /AGY_ACP_BIN/ },
    { platform: "darwin", arch: "ia32", message: /AGY_ACP_BIN/ },
    { platform: "linux", arch: "riscv64", message: /AGY_ACP_BIN/ },
  ] as const;

  for (const row of cases) {
    assert.throws(() => resolveRelease(row.platform, row.arch), row.message);
  }
});
