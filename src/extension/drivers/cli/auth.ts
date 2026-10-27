import type { DriverAuthentication } from "../types.ts";
import { loginAgyAuthentication, probeAgyAuthentication } from "../../runtime/auth.ts";

export function createCliAuthenticationBackend(getExecutable: () => string | undefined): DriverAuthentication {
  return {
    label: "Antigravity CLI",
    probe: (signal, onUsage) => probeAgyAuthentication(getExecutable(), signal, onUsage),
    login: (interaction, onUsage) => loginAgyAuthentication(interaction, getExecutable(), onUsage),
  };
}
