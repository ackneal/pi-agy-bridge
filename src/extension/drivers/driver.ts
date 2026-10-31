import type { BridgeDriver, DriverId } from "./types.ts";
import { Driver as CliDriver } from "./cli/driver.ts";
import { Driver as AcpDriver } from "./acp/driver.ts";

export function createBridgeDriver(id: DriverId = "acp"): BridgeDriver {
  if (id !== "cli" && id !== "acp") throw new Error(`Unsupported Antigravity driver: ${String(id)}`);
  return id === "cli" ? new CliDriver() : new AcpDriver();
}
