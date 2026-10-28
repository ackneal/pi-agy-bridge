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

  const remove = authentication.status === "unauthenticated"
    || (authentication.status === "unknown" && original?.type === "oauth"
      && original.driver !== undefined && original.driver !== driver);
  if (authentication.status !== "authenticated" && (!remove || !original)) return;

  const epoch = original?.type === "oauth" ? original.loginEpoch : original?.type === "api_key" ? original.env?.AGY_BRIDGE_LOGIN_EPOCH : undefined;
  const marker = authentication.status === "authenticated"
    ? createAgyBridgeCredential(typeof epoch === "string" && epoch.trim() ? epoch : undefined, driver)
    : undefined;
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, signal });
  signal.throwIfAborted();
  if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)) return;
  if (!marker) {
    await runtime.logout("agy", { signal });
    return;
  }

  runtime.registerNativeProvider({
    id: "agy", name: "Antigravity [pi-agy-bridge]", getModels: () => [],
    stream: () => { throw new Error("Antigravity authentication synchronization cannot stream"); },
    streamSimple: () => { throw new Error("Antigravity authentication synchronization cannot stream"); },
    auth: { oauth: {
      ...authentication.oauth,
      login: async (interaction) => {
        interaction.signal.throwIfAborted();
        await authentication.oauth.toAuth(marker);
        interaction.signal.throwIfAborted();
        if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)) throw new Error("Credential was superseded");
        return marker;
      },
    } },
  });

  signal.throwIfAborted();
  if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)) return;
  // Pi commits login/logout unconditionally; the checks above narrow but cannot close that commit window.
  await runtime.login("agy", "oauth", {
    signal,
    notify: () => {},
    prompt: async () => { throw new Error("Authentication synchronization cannot prompt"); },
  });
}
