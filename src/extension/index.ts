import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgyBridgeConfig } from "./shared/types.ts";
import { setDebugOverride } from "./shared/debug.ts";
import { registerAgyProvider } from "./provider/provider.ts";

export function setupAgyProvider(
  pi: ExtensionAPI,
  config?: AgyBridgeConfig
): void {
  if (config?.debug !== undefined) {
    setDebugOverride(config.debug);
  }

  registerAgyProvider(pi, config);
}

export default function piAgyBridge(pi: ExtensionAPI): void {
  setupAgyProvider(pi);
}

export type { AgyBridgeConfig } from "./shared/types.ts";
export { CompatibilityError, AgyProcessError } from "./shared/types.ts";
