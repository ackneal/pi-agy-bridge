import type { AgyBridgeConfig } from "../shared/types.ts";
import type { BridgeDriver, DriverId } from "./types.ts";
import { CliDriver } from "./cli/driver.ts";
import { AcpDriver } from "./acp/driver.ts";

export function resolveDriverId(config?: AgyBridgeConfig): DriverId {
  const id = config?.driver ?? "acp";
  if (id !== "cli" && id !== "acp") {
    throw new Error(`Unsupported Antigravity driver: ${String(id)}`);
  }
  return id;
}

export function createBridgeDriver(config?: AgyBridgeConfig): BridgeDriver {
  return resolveDriverId(config) === "cli" ? new CliDriver(config) : new AcpDriver(config);
}
