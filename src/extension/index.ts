import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgyProvider } from "./provider/provider.ts";

export { registerAgyProvider as setupAgyProvider } from "./provider/provider.ts";

export default function piAgyBridge(pi: ExtensionAPI): void {
  registerAgyProvider(pi);
}

export { CompatibilityError, AgyProcessError } from "./shared/types.ts";
