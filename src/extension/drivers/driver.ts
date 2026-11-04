import type { BridgeDriver, DriverId } from "./types.ts";
import { Driver as CliDriver } from "./cli/driver.ts";
import { Driver as AcpDriver } from "./acp/driver.ts";
import { Driver as CliAcpDriver } from "./cli-acp/driver.ts";

export function createBridgeDriver(id: DriverId = "acp"): BridgeDriver {
  if (id === "cli") return new CliDriver();
  if (id === "acp") return new AcpDriver();
  if (id === "cli-acp") return new CliAcpDriver();
  throw new Error(`Unsupported Antigravity driver: ${String(id)}`);
}
