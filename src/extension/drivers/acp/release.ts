import { readFileSync } from "node:fs";
import path from "node:path";

export interface Release {
  version: string;
  platform: string;
  url: string;
  sha256: string;
  executable: string;
  args: readonly string[];
}

const registry = JSON.parse(readFileSync(new URL("./registry.json", import.meta.url), "utf8")) as {
  id: string;
  version: string;
  distribution: { binary: Record<string, { archive: string; cmd: string; sha256: string; args?: string[] }> };
};

export function distributionName(release: Pick<Release, "url">): string {
  const filename = path.posix.basename(new URL(release.url).pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(filename)) {
    throw new Error(`Unsafe or invalid ACP archive filename '${filename}'.`);
  }

  return filename.slice(0, -".zip".length);
}

export function resolveRelease(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Release {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported ACP platform '${platform}'; the bridge supports macOS and Linux only (AGY_ACP_BIN cannot enable unsupported platforms).`);
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported ACP architecture '${arch}' on ${platform}; supported architectures are x64 and arm64. Set AGY_ACP_BIN to provide a binary for this architecture.`);
  }

  const entry = registry?.distribution?.binary?.[`${platform}-${arch === "arm64" ? "aarch64" : "x86_64"}`];
  if (registry?.id !== "antigravity-acp" || typeof registry.version !== "string" || !/^\d+\.\d+\.\d+$/.test(registry.version) ||
    !entry || typeof entry.archive !== "string" || typeof entry.cmd !== "string" ||
    typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))))) {
    throw new Error(`Invalid ACP registry snapshot for ${platform}-${arch}`);
  }

  const url = new URL(entry.archive);
  if (url.protocol !== "https:" || url.hostname !== "dl.google.com" || url.port || url.username || url.password) {
    throw new Error("ACP registry archive must use an official HTTPS Google download URL");
  }
  distributionName({ url: entry.archive });
  const executable = entry.cmd.replace(/^\.\//, "");
  if (executable.includes("\\") || executable.includes("\0") ||
    executable.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe ACP registry command '${entry.cmd}'`);
  }

  return {
    version: registry.version,
    platform: `${platform}-${arch}`,
    url: entry.archive,
    sha256: entry.sha256,
    executable,
    args: [...(entry.args ?? [])],
  };
}
