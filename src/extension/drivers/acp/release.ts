import path from "node:path";

export const ACP_RELEASE_VERSION = "1.4.3";
export const ACP_REQUIRED_EXECUTABLES = ["agy_acp_server.par", "localharness_external"] as const;

export interface AcpRelease {
  version: string;
  platform: string;
  url: string;
  sha256: string;
  executable: string;
  args: readonly string[];
}

// Google’s Zed documentation points to antigravity-acp/agent.json as the official ACP registry entry.
const RELEASES: Record<string, { os: "macos" | "linux"; arch: "arm64" | "x86_64"; sha256: string }> = {
  "darwin-arm64": { os: "macos", arch: "arm64", sha256: "c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b" },
  "darwin-x64": { os: "macos", arch: "x86_64", sha256: "9392dbbdad7f0663dbfb5a0bf641297b0cf80d2ee9cd2d49a616bbbc7378731d" },
  "linux-arm64": { os: "linux", arch: "arm64", sha256: "05c153443b0b1175151c760eeddea538950bc9843e317d54786a1f03670182bc" },
  "linux-x64": { os: "linux", arch: "x86_64", sha256: "0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714" },
};

export function acpDistributionName(release: Pick<AcpRelease, "url">): string {
  const filename = path.posix.basename(new URL(release.url).pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(filename)) {
    throw new Error(`Unsafe or invalid ACP archive filename '${filename}'.`);
  }

  return filename.slice(0, -".zip".length);
}

export function resolveAcpRelease(platform: NodeJS.Platform = process.platform, arch: string = process.arch): AcpRelease {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported ACP platform '${platform}'; the bridge supports macOS and Linux only (AGY_ACP_BIN cannot enable unsupported platforms).`);
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported ACP architecture '${arch}' on ${platform}; supported architectures are x64 and arm64. Set AGY_ACP_BIN to provide a binary for this architecture.`);
  }
  const key = `${platform}-${arch}`;
  const release = RELEASES[key]!;
  const binaryArch = release.arch;
  return {
    version: ACP_RELEASE_VERSION,
    platform: key,
    url: `https://dl.google.com/agy-extensions/releases/${release.os}/agy-acp-server-${ACP_RELEASE_VERSION}-${platform}-${binaryArch}.zip`,
    sha256: release.sha256,
    executable: "agy_acp_server.par",
    args: platform === "linux" ? ["--uid="] : [],
  };
}
