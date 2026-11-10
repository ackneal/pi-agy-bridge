#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const malformed = { decision: "deny", reason: "Malformed Request: Invalid or missing arguments" };
const unauthorized = { decision: "deny", reason: "Authorization Denied: Access is restricted to current-conversation artifacts" };

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function decide(input) {
  const id = input?.conversationId;
  const artifact = input?.artifactDirectoryPath;
  const target = input?.toolCall?.args?.Path;
  if (typeof id !== "string" || id === "" ||
      ![artifact, target].every(value => typeof value === "string" && path.isAbsolute(value) &&
        !value.includes("\0") && !value.split(path.sep).includes(".."))) {
    return malformed;
  }

  if (path.basename(artifact) !== id) {
    return unauthorized;
  }

  const stepsRoot = path.join(artifact, ".system_generated", "steps");
  const appMcpRoot = path.join(path.dirname(path.dirname(artifact)), "mcp", "pi-agy-bridge_pi");

  const isStepArtifact = inside(stepsRoot, target);
  const isMcpTarget = target.endsWith(".json") && inside(appMcpRoot, target);

  if (!isStepArtifact && !isMcpTarget) {
    return unauthorized;
  }

  const root = isStepArtifact ? stepsRoot : appMcpRoot;

  try {
    const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
    // Reject redirected roots as well as file/directory symlinks escaping the root.
    if (resolvedRoot !== root || !inside(resolvedRoot, resolvedTarget) || !(await stat(resolvedTarget)).isFile()) {
      return unauthorized;
    }
  } catch {
    return unauthorized;
  }

  return { decision: "allow" };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Input too large");
    }
    console.log(JSON.stringify(await decide(JSON.parse(input))));
  } catch {
    console.log(JSON.stringify(malformed));
  }
}
