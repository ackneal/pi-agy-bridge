import * as acp from "@agentclientprotocol/sdk";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { newDiscoverySession, withAcpDiscovery, type AcpDiscoveryOptions } from "./discovery.ts";

export interface AcpAuthenticationBackend {
  probe(signal: AbortSignal): Promise<boolean>;
  login(interaction: ProviderAuthInteraction): Promise<void>;
}

export function createAcpAuthenticationBackend(options: AcpDiscoveryOptions): AcpAuthenticationBackend {
  return {
    async probe(signal) {
      try {
        await withAcpDiscovery({ ...options, allowInteractiveAuthentication: false }, signal, async (connection) => {
          await newDiscoverySession(connection, options.cwd);
        });
        return true;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof acp.RequestError && error.code === -32000) return false;
        throw error;
      }
    },
    async login(interaction) {
      await withAcpDiscovery({ ...options, allowInteractiveAuthentication: true }, interaction.signal, async (connection, initialized) => {
        const methods = initialized.authMethods ?? [];
        if (methods.length) {
          // Selection requires explicit consent, even when the server offers just one method.
          const selectionSignal = AbortSignal.any([interaction.signal, AbortSignal.timeout(options.requestTimeoutMs ?? 180_000)]);
          const id = await new Promise<string>((resolve, reject) => {
            const abort = () => reject(selectionSignal.reason);
            selectionSignal.addEventListener("abort", abort, { once: true });
            if (selectionSignal.aborted) abort();
            void interaction.prompt({ type: "select", message: "Choose ACP authentication method",
            signal: selectionSignal, options: methods.map((method) => ({ id: method.id, label: method.name })) })
              .then(resolve, reject).finally(() => selectionSignal.removeEventListener("abort", abort));
          });
          interaction.signal.throwIfAborted();
          const method = methods.find((entry) => entry.id === id);
          if (!method) throw new Error("ACP authentication method was not advertised by the server");
          if ("type" in method && method.type === "terminal") throw new Error("ACP terminal authentication is unsupported; authenticate externally and retry");
          await connection.request(acp.methods.agent.authenticate, { methodId: method.id });
        }
        try {
          await newDiscoverySession(connection, options.cwd);
        } catch (cause) {
          throw new Error("ACP authentication could not be confirmed via session/new; authenticate externally and retry", { cause });
        }
      });
    },
  };
}
