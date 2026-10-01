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

async function assertTreeEquals(actual: string, expected: string): Promise<void> {
  assert.deepEqual([...await readTree(actual)], [...await readTree(expected)]);
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
  assert.deepEqual(actualConfig.mcpServers["pi"].args, ["-c", "exec $PI_AGY_BRIDGE_MCP_COMMAND"]);
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

test("missing AGY plugin invokes the CLI and copies every static asset byte-for-byte", async () => {
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
      /agy plugin install failed:.*installation denied/s
    );
    await assert.rejects(fs.access(target), { code: "ENOENT" });
  });
});

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

test("outdated AGY plugin synchronizes the exact static tree without invoking AGY", async () => {
  await withTemporaryHome(async (home) => {
    const target = path.join(home, ".gemini", "config", "plugins", "pi-agy-bridge");
    const otherPlugin = path.join(home, ".gemini", "config", "plugins", "unrelated-plugin");
    const configFile = path.join(home, ".gemini", "config", "unrelated.json");
    const otherPluginFile = path.join(otherPlugin, "keep.txt");
    await fs.mkdir(path.join(target, "stale", "nested"), { recursive: true });
    await fs.writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "pi-agy-bridge", version: "0.9.0" }));
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
