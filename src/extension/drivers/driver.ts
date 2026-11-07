import type { BridgeDriver, DriverId } from "./types.ts";
import { Driver as CliDriver } from "./cli/driver.ts";
import { Driver as AcpDriver } from "./acp/driver.ts";

export function createBridgeDriver(id: DriverId = "acp"): BridgeDriver {
  if (id === "cli") return new CliDriver();
  if (id === "acp") return new AcpDriver();
  throw new Error(`Unsupported Antigravity driver: ${String(id)}`);
}
