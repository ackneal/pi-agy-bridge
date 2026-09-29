import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgyBridgeConfig } from "./types.ts";
import { setDebugOverride } from "./debug.ts";
import { registerAgyProvider } from "./provider.ts";

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

export type { AgyBridgeConfig } from "./types.ts";
export { CompatibilityError, AgyProcessError } from "./types.ts";
