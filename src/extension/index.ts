import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BridgeConfig } from "./shared/types.ts";
import { setDebugOverride } from "./shared/debug.ts";
import { registerAgyProvider } from "./provider/provider.ts";

export function setupAgyProvider(
  pi: ExtensionAPI,
  config?: BridgeConfig
): void {
  if (config?.debug !== undefined) {
    setDebugOverride(config.debug);
  }

  registerAgyProvider(pi, config);
}

export default function piAgyBridge(pi: ExtensionAPI): void {
  setupAgyProvider(pi);
}

export type { BridgeConfig } from "./shared/types.ts";
export { CompatibilityError, AgyProcessError } from "./shared/types.ts";
