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
  if (typeof id !== "string" ||
      typeof artifact !== "string" || !path.isAbsolute(artifact) || artifact.includes("\0") ||
      artifact.split(path.sep).includes("..") || path.basename(artifact) !== id ||
      typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0") ||
      target.split(path.sep).includes("..")) {
    return { decision: "deny", reason: "Invalid view_file hook input" };
  }

  const root = path.join(artifact, ".system_generated", "steps");
  if (!inside(root, target)) {
    return { decision: "deny", reason: "Path is outside current conversation steps" };
  }

  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
  // Reject redirected roots as well as file/directory symlinks escaping the root.
  if (resolvedRoot !== root || !inside(resolvedRoot, resolvedTarget) || !(await stat(resolvedTarget)).isFile()) {
    return { decision: "deny", reason: "Path is not a regular file within current conversation steps" };
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
  console.log(JSON.stringify({ decision: "deny", reason: "Unable to validate view_file request" }));
}
