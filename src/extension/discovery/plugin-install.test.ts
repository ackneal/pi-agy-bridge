import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_AGY_PLUGIN_DIR, ensureAgyPluginInstalled } from "./plugin-install.ts";

async function readTree(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else files.set(path.relative(root, entryPath), await fs.readFile(entryPath));
    }
  }
  await visit(root);
  return files;
}

async function readFileMetadata(root: string): Promise<Map<string, string>> {
  const metadata = new Map<string, string>();
  for (const relativePath of (await readTree(root)).keys()) {
    const stat = await fs.stat(path.join(root, relativePath));
    metadata.set(relativePath, `${stat.mode}:${stat.size}:${stat.mtimeMs}`);
  }
  return metadata;
}

async function assertPluginAssetsEqual(actual: string, source: string): Promise<void> {
  const actualPlugin = await fs.readFile(path.join(actual, "plugin.json"), "utf8");
  const sourcePlugin = await fs.readFile(path.join(source, "plugin.json"), "utf8");
  assert.equal(actualPlugin, sourcePlugin, "plugin.json must match source");

  const actualPrompt = await fs.readFile(path.join(actual, "agents", "pi-bridge.md"), "utf8");
  const sourcePrompt = await fs.readFile(path.join(source, "agents", "pi-bridge.md"), "utf8");
  assert.equal(actualPrompt, sourcePrompt, "agents/pi-bridge.md must match source");

  const actualConfig = JSON.parse(await fs.readFile(path.join(actual, "mcp_config.json"), "utf8"));
  assert.equal(actualConfig.mcpServers["pi"].command, "sh");
  const sourceConfig = JSON.parse(await fs.readFile(path.join(source, "mcp_config.json"), "utf8"));
  assert.deepEqual(actualConfig, sourceConfig);
}

async function withTemporaryHome(callback: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-plugin-home-"));
  const originalHome = process.env.HOME;
  const originalCalls = process.env.AGY_CALLS;
  process.env.HOME = home;
  try {
    await callback(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCalls === undefined) delete process.env.AGY_CALLS;
    else process.env.AGY_CALLS = originalCalls;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeFakeAgy(home: string): Promise<{ executable: string; calls: string }> {
  const executable = path.join(home, "fake-agy");
  const calls = path.join(home, "agy-calls");
  await fs.writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$AGY_CALLS"\n`);
  await fs.chmod(executable, 0o755);
  process.env.AGY_CALLS = calls;
  return { executable, calls };
}

async function assertSingleInstallCall(calls: string, sourceDir: string): Promise<void> {
  assert.equal((await fs.readFile(calls, "utf8")).trim(), `plugin install ${sourceDir}`);
}

test("missing Antigravity CLI plugin invokes the CLI and copies every static asset byte-for-byte", async () => {
  await withTemporaryHome(async (home) => {
    const { executable, calls } = await writeFakeAgy(home);
    const target = path.join(home, ".gemini", "config", "plugins", "pi-agy-bridge");
    await ensureAgyPluginInstalled(executable, DEFAULT_AGY_PLUGIN_DIR);

    await assertPluginAssetsEqual(target, DEFAULT_AGY_PLUGIN_DIR);
    await assertSingleInstallCall(calls, DEFAULT_AGY_PLUGIN_DIR);
    assert.ok((await readTree(target)).size > 0, "static assets should be copied, not generated");
  });
});

test("failed CLI installation preserves stderr and does not copy assets", async () => {
  await withTemporaryHome(async (home) => {
    const { executable } = await writeFakeAgy(home);
    await fs.writeFile(executable, "#!/bin/sh\ncat >/dev/null\nprintf 'installation denied' >&2\nexit 7\n");
    const target = path.join(home, ".gemini", "config", "plugins", "pi-agy-bridge");

    await assert.rejects(
      ensureAgyPluginInstalled(executable, DEFAULT_AGY_PLUGIN_DIR),
      /Antigravity CLI plugin installation failed:.*installation denied/s
    );
    await assert.rejects(fs.access(target), { code: "ENOENT" });
  });
});

for (const failureStage of ["backup", "replacement", "restoration"] as const) {
  test(`failed plugin ${failureStage} preserves the installed tree`, async (t) => {
    await withTemporaryHome(async (home) => {
      const plugins = path.join(home, ".gemini", "config", "plugins");
      const target = path.join(plugins, "pi-agy-bridge");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "pi-agy-bridge", version: "0.1.1" }));
      await fs.writeFile(path.join(target, "existing.txt"), "working plugin");
      const before = await readTree(target);
      const rename = fs.rename;
      t.mock.method(fs, "rename", async (...[source, destination]: Parameters<typeof fs.rename>) => {
        if ((failureStage === "backup" && String(destination).endsWith(".backup")) ||
            (failureStage !== "backup" && String(source).endsWith(".tmp")) ||
            (failureStage === "restoration" && String(source).endsWith(".backup"))) {
          throw new Error("replacement denied");
        }
        return rename(source, destination);
      });

      await assert.rejects(ensureAgyPluginInstalled(path.join(home, "missing-agy")), failureStage === "restoration"
        ? /Plugin update failed; the previous plugin remains at/
        : /replacement denied/);

      const entries = await fs.readdir(plugins);
      if (failureStage === "restoration") {
        assert.equal(entries.length, 1);
        assert.ok(entries[0]!.endsWith(".backup"));
        assert.deepEqual(await readTree(path.join(plugins, entries[0]!)), before);
      } else {
        assert.deepEqual(await readTree(target), before);
        assert.deepEqual(entries, ["pi-agy-bridge"]);
      }
    });
  });
}

test("same-version ensures are a true no-op and never rewrite the static tree", async () => {
  await withTemporaryHome(async (home) => {
    const { executable, calls } = await writeFakeAgy(home);
    const target = path.join(home, ".gemini", "config", "plugins", "pi-agy-bridge");
    await ensureAgyPluginInstalled(executable, DEFAULT_AGY_PLUGIN_DIR);
    await fs.writeFile(path.join(target, "mcp_config.json"), "custom config");
    const beforeFiles = await readTree(target);
    const beforeMetadata = await readFileMetadata(target);

    await ensureAgyPluginInstalled(path.join(home, "missing-agy"), DEFAULT_AGY_PLUGIN_DIR);
    await ensureAgyPluginInstalled(path.join(home, "also-missing-agy"), DEFAULT_AGY_PLUGIN_DIR);

    assert.deepEqual([...await readTree(target)], [...beforeFiles]);
    assert.deepEqual(await readFileMetadata(target), beforeMetadata);
    await assertSingleInstallCall(calls, DEFAULT_AGY_PLUGIN_DIR);
  });
});

test("outdated Antigravity CLI plugin synchronizes the exact static tree without invoking Antigravity CLI", async () => {
  await withTemporaryHome(async (home) => {
    const target = path.join(home, ".gemini", "config", "plugins", "pi-agy-bridge");
    const otherPlugin = path.join(home, ".gemini", "config", "plugins", "unrelated-plugin");
    const configFile = path.join(home, ".gemini", "config", "unrelated.json");
    const otherPluginFile = path.join(otherPlugin, "keep.txt");
    await fs.mkdir(path.join(target, "stale", "nested"), { recursive: true });
    await fs.writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "pi-agy-bridge", version: "0.1.2" }));
    await fs.writeFile(path.join(target, "stale", "nested", "old.txt"), "stale");
    await fs.mkdir(otherPlugin, { recursive: true });
    await fs.writeFile(configFile, "keep config");
    await fs.writeFile(otherPluginFile, "keep plugin");
    const unrelatedBefore = new Map([
      [configFile, await fs.readFile(configFile)],
      [otherPluginFile, await fs.readFile(otherPluginFile)],
    ]);

    await ensureAgyPluginInstalled(path.join(home, "missing-agy"), DEFAULT_AGY_PLUGIN_DIR);

    await assertPluginAssetsEqual(target, DEFAULT_AGY_PLUGIN_DIR);
    for (const [file, contents] of unrelatedBefore) assert.deepEqual(await fs.readFile(file), contents);
    await assert.rejects(fs.access(path.join(target, "stale")));
  });
});

for (const scenario of [
  { name: "concurrent missing installs invoke the CLI once", installed: false, failure: undefined, distinct: false, copies: 1 },
  { name: "concurrent outdated updates synchronize once", installed: true, failure: undefined, distinct: false, copies: 1 },
  { name: "manifest failure releases the queue for retry", installed: false, failure: "manifest", distinct: false, copies: 1 },
  { name: "CLI failure releases the queue for retry", installed: false, failure: "cli", distinct: false, copies: 1 },
  { name: "sync failure releases the queue for retry", installed: true, failure: "sync", distinct: false, copies: 2 },
  { name: "distinct queued source versions both synchronize", installed: false, failure: undefined, distinct: true, copies: 2 },
] as const) {
  test(scenario.name, async (t) => {
    await withTemporaryHome(async (home) => {
      const { executable, calls } = await writeFakeAgy(home);
      const source = path.join(home, "source");
      const secondSource = path.join(home, "second-source");
      const target = path.join(home, ".gemini", "config", "plugins", "pi-agy-bridge");
      await fs.cp(DEFAULT_AGY_PLUGIN_DIR, source, { recursive: true });
      await fs.writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "pi-agy-bridge", version: "test-1" }));
      if (scenario.distinct) {
        await fs.cp(source, secondSource, { recursive: true });
        await fs.writeFile(path.join(secondSource, "plugin.json"), JSON.stringify({ name: "pi-agy-bridge", version: "test-2" }));
      }
      if (scenario.installed) {
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "pi-agy-bridge", version: "old" }));
      }
      if (scenario.failure === "cli") {
        await fs.writeFile(executable, `#!/bin/sh\nif [ ! -f "$AGY_CALLS" ]; then\n  printf 'failed\\n' > "$AGY_CALLS"\n  printf 'first install denied' >&2\n  exit 7\nfi\nprintf '%s\\n' "$*" >> "$AGY_CALLS"\n`);
      }

      const readFile = fs.readFile;
      let manifestFailed = false;
      t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
        if (scenario.failure === "manifest" && !manifestFailed && String(args[0]) === path.join(source, "plugin.json")) {
          manifestFailed = true;
          throw new Error("manifest read denied");
        }
        return readFile(...args);
      });
      const cp = fs.cp;
      const copiedSources: string[] = [];
      t.mock.method(fs, "cp", async (...args: Parameters<typeof fs.cp>) => {
        copiedSources.push(String(args[0]));
        if (scenario.failure === "sync" && copiedSources.length === 1) throw new Error("sync denied");
        return cp(...args);
      });

      const results = await Promise.allSettled([
        ensureAgyPluginInstalled(executable, source),
        ensureAgyPluginInstalled(executable, scenario.distinct ? secondSource : source),
        ensureAgyPluginInstalled(executable, scenario.distinct ? secondSource : source),
      ]);

      const firstResult = results[0]!;
      if (scenario.failure) {
        assert.ok(firstResult.status === "rejected");
        const message = {
          manifest: /manifest read denied/,
          cli: /first install denied/,
          sync: /sync denied/,
        }[scenario.failure];
        assert.match(String(firstResult.reason), message);
      } else {
        assert.equal(firstResult.status, "fulfilled");
      }
      assert.deepEqual(results.slice(1).map((result) => result.status), ["fulfilled", "fulfilled"]);
      assert.deepEqual(copiedSources, scenario.distinct ? [source, secondSource] : Array(scenario.copies).fill(source));
      await assertPluginAssetsEqual(target, scenario.distinct ? secondSource : source);
      assert.deepEqual(await fs.readdir(path.dirname(target)), ["pi-agy-bridge"]);
      if (scenario.installed) {
        await assert.rejects(fs.access(calls), { code: "ENOENT" });
      } else if (scenario.failure === "cli") {
        assert.equal(await fs.readFile(calls, "utf8"), `failed\nplugin install ${source}\n`);
      } else {
        await assertSingleInstallCall(calls, source);
      }
    });
  });
}

test("CLI environment preserves recovery, hook runtime, and shared MCP launch values", async () => {
  const { buildCliProcessEnvironment, resolveMcpEntrypoint } = await import("./plugin-install.ts");
  const { nodePath, entrypointPath } = resolveMcpEntrypoint();
  for (const endpoint of ["unix:///tmp/bridge.sock?session=test", "unix:///tmp/space and 'quotes'.sock?session=a%20b"]) {
    assert.deepEqual(buildCliProcessEnvironment(endpoint), {
      PI_AGY_BRIDGE_RECOVERY: "1",
      PI_AGY_BRIDGE_MCP_RUNTIME: nodePath,
      PI_AGY_BRIDGE_HOOK_RUNTIME: process.execPath,
      PI_AGY_BRIDGE_MCP_ENTRYPOINT: entrypointPath,
      PI_AGY_BRIDGE_MCP_ENDPOINT: endpoint,
    });
  }
});
