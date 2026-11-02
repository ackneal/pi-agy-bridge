import { ensureInstallation, findInstallation, type Launch } from "../src/extension/drivers/acp/installation.ts";
import { resolveRelease, type Release } from "../src/extension/drivers/acp/release.ts";
import type { DriverInstallationProgress } from "../src/extension/drivers/types.ts";

export async function installedAcp(onProgress?: (event: DriverInstallationProgress) => void): Promise<{ release: Release; launch: Launch }> {
  const release = resolveRelease();
  if (!findInstallation()) {
    throw Object.assign(new Error("Pinned managed ACP is missing; install it through Bridge separately"), { code: "ACP_INSTALL_REQUIRED" });
  }
  try {
    // Reuse the production inventory/hash validation, but never download or repair.
    // No consumer signal: settlement must include the validator's own cleanup.
    const launch = await ensureInstallation({ release, ...(onProgress ? { onProgress } : {}),
      fetch: async () => { throw Object.assign(new Error("Diagnostic downloads are disabled"), { code: "ACP_DOWNLOAD_DISABLED" }); },
    });
    return { release, launch };
  } catch (cause) {
    throw Object.assign(new Error("Existing managed ACP failed validation; repair it through Bridge separately", { cause }), { code: "ACP_INSTALL_INVALID" });
  }
}
