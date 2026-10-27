import assert from "node:assert/strict";
import test from "node:test";
import { acpDistributionName, resolveAcpRelease } from "./release.ts";

test("resolves pinned official ACP releases by platform and architecture", () => {
  const cases = [
    { platform: "darwin", arch: "arm64", path: "macos", binaryArch: "arm64", hash: "c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b", args: [] },
    { platform: "darwin", arch: "x64", path: "macos", binaryArch: "x86_64", hash: "9392dbbdad7f0663dbfb5a0bf641297b0cf80d2ee9cd2d49a616bbbc7378731d", args: [] },
    { platform: "linux", arch: "arm64", path: "linux", binaryArch: "arm64", hash: "05c153443b0b1175151c760eeddea538950bc9843e317d54786a1f03670182bc", args: ["--uid="] },
    { platform: "linux", arch: "x64", path: "linux", binaryArch: "x86_64", hash: "0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714", args: ["--uid="] },
  ] as const;

  for (const row of cases) {
    const release = resolveAcpRelease(row.platform, row.arch);
    assert.deepEqual(release, {
      version: "1.4.3",
      platform: `${row.platform}-${row.arch}`,
      url: `https://dl.google.com/agy-extensions/releases/${row.path}/agy-acp-server-1.4.3-${row.platform}-${row.binaryArch}.zip`,
      sha256: row.hash,
      executable: "agy_acp_server.par",
      args: row.args,
    });
  }
});

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
    assert.equal(acpDistributionName({ url: row.url }), row.expected);
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
  for (const url of cases) assert.throws(() => acpDistributionName({ url }));
});

test("rejects unsupported platform and architecture combinations", () => {
  const cases = [
    { platform: "win32", arch: "x64", message: /AGY_ACP_BIN/ },
    { platform: "freebsd", arch: "x64", message: /AGY_ACP_BIN/ },
    { platform: "darwin", arch: "ia32", message: /AGY_ACP_BIN/ },
    { platform: "linux", arch: "riscv64", message: /AGY_ACP_BIN/ },
  ] as const;

  for (const row of cases) {
    assert.throws(() => resolveAcpRelease(row.platform, row.arch), row.message);
  }
});
