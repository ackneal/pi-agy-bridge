import { isDeepStrictEqual } from "node:util";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { AgyAuthentication, createAgyBridgeCredential, isAgyBridgeEnabled } from "./auth.ts";

export async function autoConfigureAgyAuthentication(
  authentication: AgyAuthentication,
  authPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const original = readStoredCredential("agy", authPath);
  if (original?.type === "oauth" || (original && !isAgyBridgeEnabled(original))) return;

  const legacyEpoch = original?.type === "api_key" ? original.env?.AGY_BRIDGE_LOGIN_EPOCH : undefined;
  const marker = original?.type === "api_key"
    ? createAgyBridgeCredential(legacyEpoch?.trim() ? legacyEpoch : undefined)
    : await authentication.detect(signal);
  signal.throwIfAborted();
  if (!marker) return;
  if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)) return;

  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, signal });
  runtime.registerNativeProvider({
    id: "agy",
    name: "Antigravity CLI",
    getModels: () => [],
    stream: () => { throw new Error("Antigravity CLI startup authentication cannot stream"); },
    streamSimple: () => { throw new Error("Antigravity CLI startup authentication cannot stream"); },
    auth: {
      oauth: {
        ...authentication.oauth,
        login: async (interaction) => {
          interaction.signal.throwIfAborted();
          // The public auth conversion also enforces bridge shutdown/manual-login state.
          await authentication.oauth.toAuth(marker);
          interaction.signal.throwIfAborted();
          if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)) {
            throw new Error("Antigravity CLI startup credential was superseded");
          }
          // Pi 1.0.0 exposes neither its file CredentialStore nor a login mutation predicate.
          // Login commits unconditionally, so these preflight checks cannot protect the commit window.
          return marker;
        },
      },
    },
  });

  signal.throwIfAborted();
  if (!isDeepStrictEqual(readStoredCredential("agy", authPath), original)) return;
  await runtime.login("agy", "oauth", {
    signal,
    notify: () => {},
    prompt: async () => { throw new Error("Antigravity CLI startup authentication cannot prompt"); },
  });
}
