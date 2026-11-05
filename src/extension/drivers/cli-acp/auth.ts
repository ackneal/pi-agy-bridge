import * as acp from "@agentclientprotocol/sdk";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { fetchAgyUsage } from "../../runtime/usage.ts";
import type { DriverAuthentication } from "../types.ts";
import { Connection } from "./connection.ts";

export interface AcpAuthConnectionOptions {
  executable: string;
  cwd: string;
  requestTimeoutMs?: number;
}

export function isAuthRequiredError(error: unknown): boolean {
  if (error instanceof acp.RequestError) return error.code === -32000;
  if (error instanceof Error && /\b(authentication required|not authenticated|unauthenticated|login required|log in|sign in)\b/i.test(error.message)) return true;
  return false;
}

export async function withAcpConnection<T>(
  options: AcpAuthConnectionOptions,
  signal: AbortSignal | undefined,
  operation: (connection: Connection, initialized: acp.InitializeResponse) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const connection = new Connection({
    executable: options.executable,
    args: ["acp", "--stdio", "--agent", "pi-standalone"],
    cwd: options.cwd,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
  });

  const abort = () => { void connection.dispose().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const initialized = await connection.start(signal);
    signal?.throwIfAborted();

    const result = await operation(connection, initialized);
    signal?.throwIfAborted();

    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await connection.dispose();
  }
}

async function promptForAuthentication(
  interaction: ProviderAuthInteraction,
  request: Parameters<ProviderAuthInteraction["prompt"]>[0],
): Promise<string> {
  const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(180_000)]);
  signal.throwIfAborted();

  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });

  try {
    return await Promise.race([interaction.prompt({ ...request, signal }), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function createAuthenticationBackend(
  detectExecutable: () => string | undefined,
  resolveCwd: () => string,
  fetchUsage: typeof fetchAgyUsage = fetchAgyUsage,
): DriverAuthentication {
  return {
    label: "Antigravity CLI ACP",

    async probe(signal, onUsage) {
      const executable = detectExecutable();
      if (!executable) return false;

      try {
        const cwd = resolveCwd();
        await withAcpConnection({ executable, cwd }, signal, async (connection) => {
          const session = await connection.request(acp.methods.agent.session.new, {
            cwd,
            mcpServers: [],
            _meta: { antigravity: { enabledTools: [] } },
          });

          if (session?.sessionId) {
            try {
              await connection.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
            } catch {
              // Best effort session cleanup
            }
          }
        });

        try {
          const usage = await fetchUsage(executable, signal);
          signal.throwIfAborted();
          if (usage) onUsage(usage);
        } catch {
          // Usage retrieval is best-effort during auth probe
        }

        signal.throwIfAborted();
        return true;
      } catch (error) {
        signal.throwIfAborted();
        if (isAuthRequiredError(error)) return false;
        throw error;
      }
    },

    async login(interaction, onUsage) {
      const executable = detectExecutable();
      if (!executable) throw new Error("Antigravity CLI executable not found");

      const cwd = resolveCwd();
      await withAcpConnection(
        { executable, cwd, requestTimeoutMs: 180_000 },
        interaction.signal,
        async (connection, initialized) => {
          const methods = initialized.authMethods ?? [];
          if (methods.length > 0) {
            const id = await promptForAuthentication(interaction, {
              type: "select",
              message: "Choose Antigravity ACP authentication method",
              options: methods.map((method) => ({ id: method.id, label: method.name })),
            });

            interaction.signal.throwIfAborted();
            const method = methods.find((entry) => entry.id === id);
            if (!method) throw new Error("Antigravity ACP authentication method was not advertised by the server");

            if (method.id === "gemini-api-key") {
              const apiKey = await promptForAuthentication(interaction, {
                type: "secret",
                message: "Enter Gemini API key",
              });
              interaction.signal.throwIfAborted();

              await connection.request(acp.methods.agent.authenticate, {
                methodId: method.id,
                meta: { inBandKey: apiKey },
              });
            } else {
              interaction.notify({ type: "progress", message: `Authenticating with ${method.name}...` });
              await connection.request(acp.methods.agent.authenticate, { methodId: method.id });
            }
          }

          try {
            const session = await connection.request(acp.methods.agent.session.new, {
              cwd,
              mcpServers: [],
              _meta: { antigravity: { enabledTools: [] } },
            });

            if (session?.sessionId) {
              try {
                await connection.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
              } catch {
                // Best effort session cleanup
              }
            }
          } catch (cause) {
            throw new Error("Antigravity ACP authentication could not be confirmed via session/new; authenticate externally and retry", { cause });
          }
        },
      );

      try {
        const usage = await fetchUsage(executable, interaction.signal);
        interaction.signal.throwIfAborted();
        if (usage) onUsage(usage);
      } catch {
        // Usage retrieval is best-effort during login
      }

      interaction.signal.throwIfAborted();
    },
  };
}
