#!/usr/bin/env node
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function decide(input) {
  const id = input?.conversationId;
  const artifact = input?.artifactDirectoryPath;
  const target = input?.toolCall?.args?.AbsolutePath;
  if (typeof id !== "string" || id === "" ||
      typeof artifact !== "string" || !path.isAbsolute(artifact) || artifact.includes("\0") ||
      artifact.split(path.sep).includes("..") ||
      typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0") ||
      target.split(path.sep).includes("..")) {
    return { decision: "deny", reason: "Malformed Request: Invalid or missing arguments" };
  }

  const root = path.join(artifact, ".system_generated", "steps");
  if (path.basename(artifact) !== id || !inside(root, target)) {
    return { decision: "deny", reason: "Authorization Denied: Access is restricted to current-conversation artifacts" };
  }

  try {
    const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
    // Reject redirected roots as well as file/directory symlinks escaping the root.
    if (resolvedRoot !== root || !inside(resolvedRoot, resolvedTarget) || !(await stat(resolvedTarget)).isFile()) {
      return { decision: "deny", reason: "Authorization Denied: Access is restricted to current-conversation artifacts" };
    }
  } catch {
    return { decision: "deny", reason: "Authorization Denied: Access is restricted to current-conversation artifacts" };
  }

  return { decision: "allow" };
}

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Input too large");
  }
  console.log(JSON.stringify(await decide(JSON.parse(input))));
} catch {
  console.log(JSON.stringify({ decision: "deny", reason: "Malformed Request: Invalid or missing arguments" }));
}
