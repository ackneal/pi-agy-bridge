import type { DriverAuthentication } from "../types.ts";
import { loginAgyAuthentication, probeAgyAuthentication } from "../../runtime/auth.ts";

export function createCliAuthenticationBackend(agyPath?: string): DriverAuthentication {
  return {
    label: "Antigravity CLI",
    probe: (signal, onUsage) => probeAgyAuthentication(agyPath, signal, onUsage),
    login: (interaction, onUsage) => loginAgyAuthentication(interaction, agyPath, onUsage),
  };
}
