import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  AUTOMATION_BOT_EMAIL,
  AUTOMATION_BOT_LOGIN,
  AUTOMATION_BRANCH,
  AUTOMATION_REGISTRY_PATH,
  inspectGitBranchState,
  type OpenPullRequestSummary,
  type PullRequestClient,
  publishAutomationPullRequest,
  validateAutomationBranchState,
} from "../../scripts/acp-registry-pr.ts";
import {
  type AcpRegistry,
  registriesEqual,
  syncAcpRegistry,
  validateRegistry,
} from "../../scripts/acp-registry-sync.ts";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(import.meta.dirname, "../..");
const currentRegistryRaw = readFileSync(path.join(projectDir, AUTOMATION_REGISTRY_PATH), "utf8");
const currentRegistry = JSON.parse(currentRegistryRaw) as AcpRegistry;
const expectedPlatforms = Object.keys(currentRegistry.distribution.binary);

function makeRegistryVersion(version: string, shaPrefix = "a"): AcpRegistry {
  const binary = Object.fromEntries(
    Object.entries(currentRegistry.distribution.binary).map(([platform, entry], index) => {
      const hex = `${shaPrefix}${index}`.repeat(32).slice(0, 64);
      const updatedArchive = entry.archive.replace(currentRegistry.version, version);
      return [
        platform,
        {
          ...entry,
          archive: updatedArchive === entry.archive
            ? `https://dl.google.com/agy-extensions/releases/test/agy-acp-server-${version}-${platform}.zip`
            : updatedArchive,
          sha256: hex,
        },
      ];
    }),
  );

  return {
    ...currentRegistry,
    version,
    distribution: { binary },
  };
}

function withBinaryPatch(
  platform: string,
  patch: Record<string, unknown>,
): unknown {
  const binary = {
    ...currentRegistry.distribution.binary,
    [platform]: {
      ...currentRegistry.distribution.binary[platform]!,
      ...patch,
    },
  };
  return { ...currentRegistry, distribution: { binary } };
}

describe("ACP registry validation", () => {
  const cases: Array<{ name: string; candidate: unknown; error?: RegExp }> = [
    { name: "accepts valid updated registry", candidate: makeRegistryVersion("1.5.1") },
    { name: "rejects null root", candidate: null, error: /root value must be a JSON object/ },
    { name: "rejects array root", candidate: [], error: /root value must be a JSON object/ },
    { name: "rejects unexpected top-level field", candidate: { ...currentRegistry, extra: true }, error: /unsupported top-level field/ },
    {
      name: "rejects missing top-level field",
      candidate: (() => {
        const copy = { ...currentRegistry } as Record<string, unknown>;
        delete copy.version;
        return copy;
      })(),
      error: /missing required top-level field 'version'/,
    },
    { name: "rejects wrong id", candidate: { ...currentRegistry, id: "other-agent" }, error: /'id' must be 'antigravity-acp'/ },
    { name: "rejects malformed version", candidate: { ...currentRegistry, version: "1.5" }, error: /must use X\.Y\.Z format/ },
    { name: "rejects empty authors", candidate: { ...currentRegistry, authors: [] }, error: /'authors' must be a non-empty array/ },
    { name: "rejects non-HTTPS website", candidate: { ...currentRegistry, website: "http://antigravity.google" }, error: /must be an HTTPS URL/ },
    { name: "rejects extra distribution method", candidate: { ...currentRegistry, distribution: { binary: currentRegistry.distribution.binary, npx: {} } }, error: /must contain only a 'binary' map/ },
    {
      name: "rejects missing platform coverage",
      candidate: (() => {
        const binary = { ...currentRegistry.distribution.binary } as Record<string, unknown>;
        delete binary["windows-aarch64"];
        return { ...currentRegistry, distribution: { binary } };
      })(),
      error: /platform coverage mismatch/,
    },
    {
      name: "rejects extra platform coverage",
      candidate: {
        ...currentRegistry,
        distribution: {
          binary: {
            ...currentRegistry.distribution.binary,
            "freebsd-x86_64": currentRegistry.distribution.binary["linux-x86_64"],
          },
        },
      },
      error: /platform coverage mismatch/,
    },
    {
      name: "rejects renamed platform coverage",
      candidate: (() => {
        const binary = { ...currentRegistry.distribution.binary } as Record<string, unknown>;
        binary["darwin-arm64"] = binary["darwin-aarch64"];
        delete binary["darwin-aarch64"];
        return { ...currentRegistry, distribution: { binary } };
      })(),
      error: /platform coverage mismatch/,
    },
    {
      name: "rejects unsupported platform entry field",
      candidate: withBinaryPatch("linux-x86_64", { env: { FOO: "bar" } }),
      error: /contains unsupported field 'env'/,
    },
    {
      name: "rejects malformed archive URL",
      candidate: withBinaryPatch("linux-x86_64", { archive: "not a url" }),
      error: /is not a valid URL/,
    },
    {
      name: "rejects non-HTTPS archive URL",
      candidate: withBinaryPatch("linux-x86_64", {
        archive: currentRegistry.distribution.binary["linux-x86_64"]!.archive.replace("https:", "http:"),
      }),
      error: /must be an HTTPS URL/,
    },
    {
      name: "rejects non-Google archive host",
      candidate: withBinaryPatch("linux-x86_64", {
        archive: "https://example.test/agy-acp-server-1.5.0-linux-x86_64.zip",
      }),
      error: /official dl\.google\.com HTTPS URL/,
    },
    {
      name: "rejects archive URL with credentials",
      candidate: withBinaryPatch("linux-x86_64", {
        archive: currentRegistry.distribution.binary["linux-x86_64"]!.archive.replace("https://", "https://user:pass@"),
      }),
      error: /HTTPS URL without credentials/,
    },
    {
      name: "rejects non-ZIP archive filename",
      candidate: withBinaryPatch("linux-x86_64", {
        archive: "https://dl.google.com/agy-extensions/releases/linux/server.tar.gz",
      }),
      error: /must be a safe \.zip filename/,
    },
    {
      name: "rejects invalid SHA-256 checksum",
      candidate: withBinaryPatch("linux-x86_64", { sha256: "ABC123" }),
      error: /invalid SHA-256/,
    },
    {
      name: "rejects unsafe command traversal",
      candidate: withBinaryPatch("linux-x86_64", { cmd: "../server" }),
      error: /unsafe command/,
    },
    {
      name: "rejects invalid args",
      candidate: withBinaryPatch("linux-x86_64", { args: "--uid=" }),
      error: /args must be an array/,
    },
  ];

  for (const row of cases) {
    it(row.name, () => {
      if (row.error) {
        assert.throws(() => validateRegistry(row.candidate, expectedPlatforms), row.error);
      } else {
        const validated = validateRegistry(row.candidate, expectedPlatforms);
        assert.equal(validated.version, (row.candidate as AcpRegistry).version);
      }
    });
  }
});

describe("ACP registry sync", () => {
  const reorderedIdentical = {
    distribution: {
      binary: Object.fromEntries(Object.entries(currentRegistry.distribution.binary).reverse()),
    },
    license_url: currentRegistry.license_url,
    license: currentRegistry.license,
    authors: [...currentRegistry.authors],
    website: currentRegistry.website,
    description: currentRegistry.description,
    version: currentRegistry.version,
    name: currentRegistry.name,
    id: currentRegistry.id,
  };

  const cases: Array<{
    name: string;
    upstreamUrl?: string;
    fetchImpl?: typeof fetch;
    expectedResult?: Awaited<ReturnType<typeof syncAcpRegistry>>;
    expectedError?: RegExp;
    expectUpdatedVersion?: string;
  }> = [
    {
      name: "skips when upstream URL is missing",
      upstreamUrl: "   ",
      fetchImpl: () => {
        throw new Error("fetch must not be called when upstream URL is missing");
      },
      expectedResult: { status: "skipped", reason: "ACP_REGISTRY_UPSTREAM_URL is not set." },
    },
    {
      name: "does not update when upstream is structurally equal",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response(JSON.stringify(reorderedIdentical), { status: 200 }),
      expectedResult: { status: "unchanged", localVersion: currentRegistry.version, upstreamVersion: currentRegistry.version },
    },
    {
      name: "updates local registry on valid upstream change",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response(JSON.stringify(makeRegistryVersion("1.5.1")), { status: 200 }),
      expectedResult: { status: "updated", localVersion: currentRegistry.version, upstreamVersion: "1.5.1" },
      expectUpdatedVersion: "1.5.1",
    },
    {
      name: "rejects invalid JSON and preserves local registry",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response("{not valid json", { status: 200 }),
      expectedError: /not valid JSON/,
    },
    {
      name: "rejects invalid upstream structure and preserves local registry",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response(JSON.stringify({ id: "wrong" }), { status: 200 }),
      expectedError: /Invalid ACP registry/,
    },
    {
      name: "rejects missing platform coverage and preserves local registry",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => {
        const invalid = makeRegistryVersion("1.5.1");
        delete invalid.distribution.binary["darwin-aarch64"];
        return new Response(JSON.stringify(invalid), { status: 200 });
      },
      expectedError: /platform coverage mismatch/,
    },
    {
      name: "rejects invalid archive URL and preserves local registry",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () =>
        new Response(JSON.stringify(withBinaryPatch("darwin-aarch64", { archive: "https://evil.example/a.zip" })), {
          status: 200,
        }),
      expectedError: /official dl\.google\.com HTTPS URL/,
    },
    {
      name: "rejects invalid SHA-256 and preserves local registry",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () =>
        new Response(JSON.stringify(withBinaryPatch("darwin-aarch64", { sha256: "not-a-sha256" })), {
          status: 200,
        }),
      expectedError: /invalid SHA-256/,
    },
    {
      name: "rejects HTTP error and preserves local registry",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response("Internal Error", { status: 500, statusText: "Internal Server Error" }),
      expectedError: /HTTP 500/,
    },
    {
      name: "rejects network failure and preserves local registry",
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      expectedError: /fetch failed/,
    },
    {
      name: "rejects malformed upstream URL and preserves local registry",
      upstreamUrl: "not-a-url",
      expectedError: /Invalid ACP_REGISTRY_UPSTREAM_URL/,
    },
    {
      name: "rejects unsupported upstream URL protocol and preserves local registry",
      upstreamUrl: "file:///tmp/registry.json",
      expectedError: /Unsupported ACP_REGISTRY_UPSTREAM_URL protocol/,
    },
  ];

  for (const row of cases) {
    it(row.name, async (t) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "acp-registry-sync-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const localPath = path.join(dir, "registry.json");
      await writeFile(localPath, currentRegistryRaw, "utf8");

      const run = syncAcpRegistry({
        registryPath: localPath,
        upstreamUrl: row.upstreamUrl,
        ...(row.fetchImpl ? { fetchImpl: row.fetchImpl } : {}),
      });

      if (row.expectedError) {
        await assert.rejects(run, row.expectedError);
        assert.equal(await readFile(localPath, "utf8"), currentRegistryRaw);
        return;
      }

      const result = await run;
      assert.deepEqual(result, row.expectedResult);
      const afterRaw = await readFile(localPath, "utf8");
      if (row.expectUpdatedVersion) {
        const afterParsed = JSON.parse(afterRaw) as AcpRegistry;
        assert.equal(afterParsed.version, row.expectUpdatedVersion);
        assert.ok(registriesEqual(afterParsed, makeRegistryVersion(row.expectUpdatedVersion)));
      } else {
        assert.equal(afterRaw, currentRegistryRaw);
      }
    });
  }
});

describe("ACP registry PR branch ownership guard", () => {
  const tableCases: Array<{
    name: string;
    state: Parameters<typeof validateAutomationBranchState>[0];
    expected?: ReturnType<typeof validateAutomationBranchState>;
    error?: RegExp;
  }> = [
    {
      name: "allows creating a new automation branch",
      state: { branchExists: false, openPullRequests: [], commits: [], changedFiles: [] },
      expected: { mode: "create" },
    },
    {
      name: "allows updating an open automation PR when only bot commits touch registry.json",
      state: {
        branchExists: true,
        openPullRequests: [{ number: 48, authorLogin: AUTOMATION_BOT_LOGIN, baseRef: "main" }],
        commits: [{ sha: "abcdef1234567", authorEmail: AUTOMATION_BOT_EMAIL, committerEmail: AUTOMATION_BOT_EMAIL }],
        changedFiles: [AUTOMATION_REGISTRY_PATH],
      },
      expected: { mode: "update", prNumber: 48 },
    },
    {
      name: "allows recreating PR on leftover bot-only branch without open PR",
      state: {
        branchExists: true,
        openPullRequests: [],
        commits: [{ sha: "abcdef1234567", authorEmail: AUTOMATION_BOT_EMAIL, committerEmail: AUTOMATION_BOT_EMAIL }],
        changedFiles: [AUTOMATION_REGISTRY_PATH],
      },
      expected: { mode: "recreate" },
    },
    {
      name: "rejects manually created open PR on fixed branch",
      state: {
        branchExists: true,
        openPullRequests: [{ number: 49, authorLogin: "ackneal", baseRef: "main" }],
        commits: [{ sha: "abcdef1234567", authorEmail: AUTOMATION_BOT_EMAIL, committerEmail: AUTOMATION_BOT_EMAIL }],
        changedFiles: [AUTOMATION_REGISTRY_PATH],
      },
      error: /owned by 'ackneal'/,
    },
    {
      name: "rejects open PR targeting non-main base",
      state: {
        branchExists: true,
        openPullRequests: [{ number: 50, authorLogin: AUTOMATION_BOT_LOGIN, baseRef: "develop" }],
        commits: [{ sha: "abcdef1234567", authorEmail: AUTOMATION_BOT_EMAIL, committerEmail: AUTOMATION_BOT_EMAIL }],
        changedFiles: [AUTOMATION_REGISTRY_PATH],
      },
      error: /targets 'develop' instead of 'main'/,
    },
    {
      name: "rejects existing branch with manual commit",
      state: {
        branchExists: true,
        openPullRequests: [{ number: 48, authorLogin: AUTOMATION_BOT_LOGIN, baseRef: "main" }],
        commits: [
          { sha: "1111111222222", authorEmail: "human@example.com", committerEmail: "human@example.com" },
          { sha: "abcdef1234567", authorEmail: AUTOMATION_BOT_EMAIL, committerEmail: AUTOMATION_BOT_EMAIL },
        ],
        changedFiles: [AUTOMATION_REGISTRY_PATH],
      },
      error: /not authored and committed by/,
    },
    {
      name: "rejects existing branch with unrelated file changes",
      state: {
        branchExists: true,
        openPullRequests: [{ number: 48, authorLogin: AUTOMATION_BOT_LOGIN, baseRef: "main" }],
        commits: [{ sha: "abcdef1234567", authorEmail: AUTOMATION_BOT_EMAIL, committerEmail: AUTOMATION_BOT_EMAIL }],
        changedFiles: [AUTOMATION_REGISTRY_PATH, "README.md"],
      },
      error: /modifies unrelated file\(s\): README\.md/,
    },
    {
      name: "allows recreating PR on already-merged branch with zero unmerged commits",
      state: {
        branchExists: true,
        openPullRequests: [],
        commits: [],
        changedFiles: [],
      },
      expected: { mode: "recreate" },
    },
  ];

  for (const row of tableCases) {
    it(row.name, () => {
      if (row.error) {
        assert.throws(() => validateAutomationBranchState(row.state), row.error);
      } else {
        assert.deepEqual(validateAutomationBranchState(row.state), row.expected);
      }
    });
  }

  it("creates, skips unchanged, updates on newer upstream version, and blocks manual commits", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acp-registry-git-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const remoteDir = path.join(dir, "remote.git");
    const workDir = path.join(dir, "work");
    const git = (args: string[], env?: NodeJS.ProcessEnv) =>
      execFileAsync("git", args, { cwd: workDir, env: { ...process.env, ...env } });

    await execFileAsync("git", ["init", "--bare", remoteDir]);
    await execFileAsync("git", ["clone", remoteDir, workDir]);
    await git(["checkout", "-b", "main"]);
    await git(["config", "user.name", "Maintainer"]);
    await git(["config", "user.email", "maintainer@example.com"]);

    const registryFile = path.join(workDir, AUTOMATION_REGISTRY_PATH);
    await mkdir(path.dirname(registryFile), { recursive: true });
    await writeFile(registryFile, currentRegistryRaw, "utf8");
    await git(["add", AUTOMATION_REGISTRY_PATH]);
    await git(["commit", "-m", "chore: initial registry 1.5.0"]);
    await git(["push", "-u", "origin", "main"]);

    let openPrs: OpenPullRequestSummary[] = [];
    const prCalls: Array<{ action: "create" | "update"; title: string; body: string; prNumber?: number }> = [];
    const prClient: PullRequestClient = {
      async fetchOpenPullRequests() {
        return openPrs;
      },
      async createPullRequest({ title, body }) {
        prCalls.push({ action: "create", title, body });
        openPrs = [{ number: 48, authorLogin: AUTOMATION_BOT_LOGIN, baseRef: "main" }];
        return "https://github.com/ackneal/pi-agy-bridge/pull/48";
      },
      async updatePullRequest({ prNumber, title, body }) {
        prCalls.push({ action: "update", prNumber, title, body });
      },
    };

    // 1. Initial upstream 1.5.1 creates branch + PR #48.
    await syncAcpRegistry({
      registryPath: registryFile,
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response(JSON.stringify(makeRegistryVersion("1.5.1", "a")), { status: 200 }),
    });
    const created = await publishAutomationPullRequest({
      cwd: workDir,
      repository: "ackneal/pi-agy-bridge",
      localVersion: currentRegistry.version,
      upstreamVersion: "1.5.1",
      upstreamUrl: "https://registry.test/agent.json",
      prClient,
    });
    assert.deepEqual(created, {
      status: "created",
      mode: "create",
      prUrl: "https://github.com/ackneal/pi-agy-bridge/pull/48",
    });
    assert.equal(prCalls.length, 1);
    assert.equal(prCalls[0]?.action, "create");
    assert.equal(prCalls[0]?.title, "chore: update ACP registry to 1.5.1");
    assert.match(prCalls[0]?.body ?? "", /from `1\.5\.0` to `1\.5\.1`/);

    // 2. Re-running with the same upstream 1.5.1 while PR #48 is open skips push and PR edit.
    await git(["checkout", "main"]);
    await syncAcpRegistry({
      registryPath: registryFile,
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response(JSON.stringify(makeRegistryVersion("1.5.1", "a")), { status: 200 }),
    });
    const unchanged = await publishAutomationPullRequest({
      cwd: workDir,
      repository: "ackneal/pi-agy-bridge",
      localVersion: currentRegistry.version,
      upstreamVersion: "1.5.1",
      upstreamUrl: "https://registry.test/agent.json",
      prClient,
    });
    assert.deepEqual(unchanged, { status: "unchanged", mode: "update", prNumber: 48 });
    assert.equal(prCalls.length, 1);

    // 3. Newer upstream 1.5.2 resets the branch to 1 commit and updates PR #48.
    await git(["checkout", "main"]);
    const syncResult = await syncAcpRegistry({
      registryPath: registryFile,
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response(JSON.stringify(makeRegistryVersion("1.5.2", "b")), { status: 200 }),
    });
    assert.deepEqual(syncResult, {
      status: "updated",
      localVersion: currentRegistry.version,
      upstreamVersion: "1.5.2",
    });
    const updated = await publishAutomationPullRequest({
      cwd: workDir,
      repository: "ackneal/pi-agy-bridge",
      localVersion: currentRegistry.version,
      upstreamVersion: "1.5.2",
      upstreamUrl: "https://registry.test/agent.json",
      prClient,
    });
    assert.deepEqual(updated, { status: "updated", mode: "update", prNumber: 48 });
    assert.equal(prCalls.length, 2);
    assert.equal(prCalls[1]?.action, "update");
    assert.equal(prCalls[1]?.prNumber, 48);
    assert.equal(prCalls[1]?.title, "chore: update ACP registry to 1.5.2");
    assert.match(prCalls[1]?.body ?? "", /from `1\.5\.0` to `1\.5\.2`/);

    await git(["checkout", "main"]);
    const gitStateAfterUpdate = await inspectGitBranchState({ cwd: workDir });
    assert.deepEqual(gitStateAfterUpdate.changedFiles, [AUTOMATION_REGISTRY_PATH]);
    assert.equal(gitStateAfterUpdate.commits.length, 1);

    // 4. A manual commit on the fixed branch must block future automation updates before committing/pushing.
    await git(["checkout", AUTOMATION_BRANCH]);
    await writeFile(path.join(workDir, "README.md"), "manual note\n", "utf8");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "docs: manual edit"]);
    await git(["push", "origin", AUTOMATION_BRANCH]);
    await git(["checkout", "main"]);

    await syncAcpRegistry({
      registryPath: registryFile,
      upstreamUrl: "https://registry.test/agent.json",
      fetchImpl: async () => new Response(JSON.stringify(makeRegistryVersion("1.5.3", "c")), { status: 200 }),
    });
    await assert.rejects(
      () =>
        publishAutomationPullRequest({
          cwd: workDir,
          repository: "ackneal/pi-agy-bridge",
          localVersion: currentRegistry.version,
          upstreamVersion: "1.5.3",
          prClient,
        }),
      /not authored and committed by/,
    );
    assert.equal(prCalls.length, 2);
  });
});
