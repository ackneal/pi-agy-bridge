import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const plugin = fileURLToPath(new URL("../../plugin/", import.meta.url));
const id = "12345678-1234-4234-8234-123456789abc";
const otherId = "12345678-1234-4234-8234-123456789abd";

it("restricts native view_file to current conversation regular step files", async (t) => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "offload-hook-")));
  try {
    const brain = path.join(home, "custom-artifacts");
    const artifact = path.join(brain, id);
    const steps = path.join(artifact, ".system_generated/steps");
    const other = path.join(brain, otherId, ".system_generated/steps");
    await mkdir(steps, { recursive: true });
    await mkdir(other, { recursive: true });
    const file = path.join(steps, "artifact.md");
    const project = path.join(home, "project.txt");
    await writeFile(file, "artifact");
    await writeFile(project, "private");
    await writeFile(path.join(other, "artifact.md"), "other conversation");
    await symlink(project, path.join(steps, "escape"));
    await symlink(other, path.join(steps, "other"));
    await symlink(file, path.join(steps, "internal"));
    const redirectedArtifact = path.join(home, "redirected", id);
    await mkdir(path.dirname(redirectedArtifact), { recursive: true });
    await symlink(path.join(brain, otherId), redirectedArtifact);
    const redirectedSteps = path.join(home, "redirected-steps", id, ".system_generated", "steps");
    await mkdir(path.dirname(redirectedSteps), { recursive: true });
    await symlink(other, redirectedSteps);
    const namedArtifact = path.join(brain, "named-conversation");
    const namedFile = path.join(namedArtifact, ".system_generated/steps/artifact.md");
    await mkdir(path.dirname(namedFile), { recursive: true });
    await writeFile(namedFile, "artifact");
    const request = (target: string, conversationId = id) => ({ conversationId, artifactDirectoryPath: artifact, toolCall: { name: "view_file", args: { AbsolutePath: target } } });
    const cases = [
      { name: "current artifact outside default CLI home", input: request(file), decision: "allow" },
      { name: "non-UUID conversation", input: { conversationId: "named-conversation", artifactDirectoryPath: namedArtifact, toolCall: { args: { AbsolutePath: namedFile } } }, decision: "allow" },
      { name: "internal symlink", input: request(path.join(steps, "internal")), decision: "allow" },
      { name: "cross conversation", input: request(path.join(other, "artifact.md")), decision: "deny" },
      { name: "project file", input: request(project), decision: "deny" },
      ...[undefined, null, 1, "", "relative", `${artifact}/../${id}`, `${artifact}\0`, home, path.join(brain, otherId)].map((value) => ({
        name: `invalid artifact metadata ${JSON.stringify(value)}`,
        input: { ...request(file), artifactDirectoryPath: value },
        decision: "deny",
      })),
      ...[undefined, null, 1, "", "not-a-uuid"].map((value) => ({
        name: `invalid conversation metadata ${JSON.stringify(value)}`,
        input: { ...request(file), conversationId: value },
        decision: "deny",
      })),
      { name: "redirected artifact root", input: { ...request(path.join(redirectedArtifact, ".system_generated/steps/artifact.md")), artifactDirectoryPath: redirectedArtifact }, decision: "deny" },
      { name: "redirected steps root", input: { ...request(path.join(redirectedSteps, "artifact.md")), artifactDirectoryPath: path.dirname(path.dirname(redirectedSteps)) }, decision: "deny" },
      { name: "untrusted artifact root", input: { ...request(project), artifactDirectoryPath: home }, decision: "deny" },
      { name: "file symlink escape", input: request(path.join(steps, "escape")), decision: "deny" },
      { name: "directory symlink escape", input: request(path.join(steps, "other/artifact.md")), decision: "deny" },
      { name: "directory", input: request(steps), decision: "deny" },
      { name: "missing file", input: request(path.join(steps, "missing")), decision: "deny" },
      { name: "traversal", input: request(`${steps}/../steps/artifact.md`), decision: "deny" },
      { name: "relative path", input: request("artifact.md"), decision: "deny" },
      { name: "conversation mismatch", input: request(file, "../escape"), decision: "deny" },
      { name: "tool selection belongs to manifest", input: { ...request(file), toolCall: { name: "read_file", args: { AbsolutePath: file } } }, decision: "allow" },
      { name: "null", input: null, decision: "deny" },
      { name: "missing fields", input: {}, decision: "deny" },
      { name: "wrong path type", input: { ...request(file), toolCall: { name: "view_file", args: { AbsolutePath: 1 } } }, decision: "deny" },
      { name: "malformed JSON", input: undefined, decision: "deny" },
    ];
    const manifest = JSON.parse(await readFile(path.join(plugin, "hooks.json"), "utf8"));
    const policy = manifest["restrict-view-file"].PreToolUse[0];
    assert.equal(policy.matcher, "^view_file$");
    const hook = policy.hooks[0];
    assert.equal(hook.type, "command");
    assert.equal(hook.timeout, 5);
    for (const row of cases) {
      await t.test(row.name, () => {
        const result = spawnSync("sh", ["-c", hook.command], {
          cwd: plugin,
          env: { ...process.env, HOME: home, PI_AGY_BRIDGE_RECOVERY: "1", PI_AGY_BRIDGE_HOOK_RUNTIME: process.execPath },
          input: row.input === undefined ? "{" : JSON.stringify(row.input),
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        const output = JSON.parse(result.stdout);
        assert.equal(output.decision, row.decision);
        if (row.decision === "deny") assert.ok(output.reason);
        else assert.deepEqual(output, { decision: "allow" });
      });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("gates the command on the exact recovery marker", async (t) => {
  const manifest = JSON.parse(await readFile(path.join(plugin, "hooks.json"), "utf8"));
  const command = manifest["restrict-view-file"].PreToolUse[0].hooks[0].command;
  const missingNode = path.join(plugin, "nonexistent-node");
  const cases = [
    { name: "unmarked delegates despite invalid metadata", marker: undefined, node: process.execPath, input: "{}", decision: "allow" },
    { name: "unmarked with unset Node delegates malformed input", marker: undefined, node: undefined, input: "{", decision: "allow" },
    { name: "unmarked with missing Node delegates", marker: undefined, node: missingNode, input: "{}", decision: "allow" },
    ...["", "0", "true", "01", "1 ", " 1"].map((marker) => ({
      name: `nonexact marker ${JSON.stringify(marker)} delegates without Node`, marker, node: undefined, input: "{", decision: "allow",
    })),
    { name: "marked enforces metadata restrictions", marker: "1", node: process.execPath, input: "{}", decision: "deny" },
    { name: "marked denies malformed input", marker: "1", node: process.execPath, input: "{", decision: "deny" },
    { name: "marked with unset Node fails closed", marker: "1", node: undefined, input: "{}", decision: undefined },
    { name: "marked with missing Node fails closed", marker: "1", node: missingNode, input: "{}", decision: undefined },
  ];
  for (const row of cases) {
    await t.test(row.name, () => {
      const env = { ...process.env };
      delete env.PI_AGY_BRIDGE_RECOVERY;
      delete env.PI_AGY_BRIDGE_HOOK_RUNTIME;
      if (row.marker !== undefined) env.PI_AGY_BRIDGE_RECOVERY = row.marker;
      if (row.node !== undefined) env.PI_AGY_BRIDGE_HOOK_RUNTIME = row.node;

      const result = spawnSync("sh", ["-c", command], { cwd: plugin, env, input: row.input, encoding: "utf8" });
      assert.ifError(result.error);
      if (row.decision === undefined) {
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      if (row.decision === "allow") assert.deepEqual(output, { decision: "allow" });
      else {
        assert.equal(output.decision, "deny");
        assert.ok(output.reason);
      }
    });
  }
});
