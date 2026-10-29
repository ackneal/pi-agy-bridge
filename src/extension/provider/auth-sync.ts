import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
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
  if (marker) await authentication.oauth.toAuth(marker);
  signal.throwIfAborted();
  mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
  try { writeFileSync(authPath, "{}", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }

  let release: (() => Promise<void>) | undefined;
  let compromised: Error | undefined;
  const deadline = Date.now() + 30_000;
  let waitMs = 10;
  while (!release) {
    signal.throwIfAborted();
    try {
      // Match Pi's FileAuthStorageBackend lock path and asynchronous lock settings.
      release = await lockfile.lock(authPath, {
        realpath: false, stale: 30_000, retries: 0,
        onCompromised: (error) => { compromised = error; },
      });
    } catch (error) {
      signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || remaining <= 0) throw error;
      try { await delay(Math.min(waitMs, remaining), undefined, { signal }); }
      catch (error) { signal.throwIfAborted(); throw error; }
      waitMs = Math.min(waitMs * 2, 1000);
    }
  }

  try {
    signal.throwIfAborted();
    if (compromised) throw compromised;
    // No await between the locked comparison and write: another Pi writer must wait.
    const data: unknown = JSON.parse(readFileSync(authPath, "utf8").replace(/^\uFEFF/, ""));
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Invalid auth.json: expected an object");
    const credentials = data as Record<string, unknown>;
    if (!isDeepStrictEqual(credentials.agy, original)) return;
    if (marker) credentials.agy = marker;
    else delete credentials.agy;
    signal.throwIfAborted();
    writeFileSync(authPath, JSON.stringify(credentials, null, 2), { encoding: "utf8", mode: 0o600 });
  } finally {
    // proper-lockfile already relinquishes ownership when a lock is compromised.
    if (!compromised) await release();
  }
}
