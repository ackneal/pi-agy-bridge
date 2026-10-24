import type { AgyAuthenticationBackend } from "../../provider/auth.ts";
import { loginAgyAuthentication, probeAgyAuthentication } from "../../runtime/auth.ts";

export function createCliAuthenticationBackend(agyPath?: string): AgyAuthenticationBackend {
  return {
    label: "Antigravity CLI",
    probe: (signal, onUsage) => probeAgyAuthentication(agyPath, signal, onUsage),
    login: (interaction, onUsage) => loginAgyAuthentication(interaction, agyPath, onUsage),
  };
}
