import { isDeepStrictEqual } from "node:util";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { Credential } from "@earendil-works/pi-ai";
import type { DriverId } from "../drivers/types.ts";
import { AgyAuthentication, createAgyBridgeCredential, isAgyBridgeEnabled } from "./auth.ts";

export async function synchronizeAgyAuthentication(
  authentication: AgyAuthentication,
  driver: DriverId,
  authPath: string,
  signal: AbortSignal,
  original: Credential | undefined,
): Promise<void> {
  signal.throwIfAborted();
  if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)
    || (original !== undefined && !isAgyBridgeEnabled(original))) return;

  if (authentication.status === "unknown") return;
  if (authentication.status === "unauthenticated" && !original) return;
  if (authentication.status === "authenticated" && original?.type === "oauth"
    && isAgyBridgeEnabled(original, driver)) return;

  const marker = authentication.status === "authenticated" ? createAgyBridgeCredential(driver) : undefined;
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, signal });
  runtime.registerNativeProvider({
    id: "agy", name: "Antigravity CLI", getModels: () => [],
    stream: () => { throw new Error("Antigravity authentication synchronization cannot stream"); },
    streamSimple: () => { throw new Error("Antigravity authentication synchronization cannot stream"); },
    auth: {
      oauth: {
        ...authentication.oauth,
        login: async (interaction) => {
          interaction.signal.throwIfAborted();
          if (!marker) throw new Error("Antigravity authentication is unavailable");
          await authentication.oauth.toAuth(marker);
          interaction.signal.throwIfAborted();
          if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)) {
            throw new Error("Antigravity credential was superseded");
          }
          return marker;
        },
      },
    },
  });

  signal.throwIfAborted();
  if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)) return;
  // Pi owns persistence. These preflight checks leave a small cross-process commit race.
  if (marker) {
    await runtime.login("agy", "oauth", {
      signal, notify: () => {},
      prompt: async () => { throw new Error("Authentication synchronization cannot prompt"); },
    });
  } else {
    await runtime.logout("agy", { signal });
  }
}
