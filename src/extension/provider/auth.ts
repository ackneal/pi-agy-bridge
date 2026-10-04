import { randomUUID } from "node:crypto";
import type { ApiKeyAuth, Credential, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { loginAgyAuthentication, probeAgyAuthentication } from "../runtime/auth.ts";
import type { DoctorFailure } from "./doctor.ts";

const year = 365 * 24 * 60 * 60 * 1000;
const prefix = "agy-bridge:";

export function createAgyBridgeCredential(loginEpoch: string = randomUUID()): OAuthCredential {
  if (!loginEpoch.trim()) throw new Error("Antigravity CLI authentication session is no longer valid");
  return { type: "oauth", access: "", refresh: "", expires: Date.now() + year, agyBridge: true, loginEpoch };
}

export function isAgyBridgeEnabled(credential: Credential | undefined): boolean {
  if (credential?.type === "api_key") return credential.env?.AGY_BRIDGE_ENABLED === "1";
  return credential?.type === "oauth" && credential.agyBridge === true
    && typeof credential.loginEpoch === "string" && credential.loginEpoch.trim().length > 0
    && credential.access === "" && credential.refresh === "";
}

export function getAgyBridgeAuthEnvironment(apiKey?: string): Record<string, string> | undefined {
  if (!apiKey?.startsWith(prefix)) return undefined;
  try {
    const epoch = decodeURIComponent(apiKey.slice(prefix.length));
    if (!epoch.trim()) return undefined;
    return { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: epoch };
  } catch {
    return undefined;
  }
}

/** Pi stores consent to use the bridge, not AGY's authentication tokens. */
export class AgyAuthentication {
  public status: "authenticated" | "unauthenticated" | "unknown" = "unknown";
  public failure: DoctorFailure | undefined;
  public readonly method: ApiKeyAuth;
  public readonly oauth: OAuthAuth;
  private detection: Promise<OAuthCredential | undefined> | undefined;
  private readonly detectionCancellation = new AbortController();
  private readonly lifecycle = new AbortController();
  private generation = 0;
  private loggingIn = false;
  private readonly agyPath: string | undefined;

  constructor(agyPath: string | undefined, beforeLogin: () => Promise<void>) {
    this.agyPath = agyPath;
    this.method = {
      name: "AGY CLI",
      check: async ({ credential, signal }) => {
        signal.throwIfAborted();
        return isAgyBridgeEnabled(credential)
          ? { type: "api_key", source: "AGY CLI" }
          : undefined;
      },
      resolve: async ({ credential, signal }) => {
        if (!isAgyBridgeEnabled(credential) || this.loggingIn) return undefined;
        signal.throwIfAborted();
        this.lifecycle.signal.throwIfAborted();

        const epoch = credential?.env?.AGY_BRIDGE_LOGIN_EPOCH;
        return {
          auth: {},
          env: { AGY_BRIDGE_ENABLED: "1", ...(typeof epoch === "string" && epoch.length > 0 ? { AGY_BRIDGE_LOGIN_EPOCH: epoch } : {}) },
          source: "AGY CLI",
        };
      },
    };
    this.oauth = {
      name: "AGY CLI",
      isSubscription: true,
      refresh: async (credential, signal) => {
        signal.throwIfAborted();
        this.lifecycle.signal.throwIfAborted();
        if (!isAgyBridgeEnabled(credential)) throw new Error("Invalid Antigravity CLI bridge credentials");
        return { ...credential, expires: Date.now() + year };
      },
      toAuth: async (credential) => {
        this.lifecycle.signal.throwIfAborted();
        if (this.loggingIn) throw new Error("Antigravity CLI authentication is already in progress");
        if (!isAgyBridgeEnabled(credential)) throw new Error("Invalid Antigravity CLI bridge credentials");
        return { apiKey: prefix + encodeURIComponent(credential.loginEpoch as string) };
      },
      login: async (interaction) => {
        if (this.loggingIn) throw new Error("Antigravity CLI authentication is already in progress");
        this.lifecycle.signal.throwIfAborted();
        this.loggingIn = true;
        this.detectionCancellation.abort(new Error("Antigravity CLI status check was replaced by a newer attempt"));
        const generation = ++this.generation;
        this.status = "unknown";
        const signal = AbortSignal.any([interaction.signal, this.lifecycle.signal]);
        try {
          signal.throwIfAborted();
          await beforeLogin();
          signal.throwIfAborted();
          interaction.notify({ type: "progress", message: "Checking Antigravity CLI authentication status" });
          await loginAgyAuthentication({ ...interaction, signal } satisfies ProviderAuthInteraction, this.agyPath);
          signal.throwIfAborted();
          if (generation !== this.generation) throw new Error("Antigravity CLI authentication was replaced by a newer attempt");
          this.status = "authenticated";
          this.failure = undefined;
          return createAgyBridgeCredential();
        } catch (error) {
          if (generation === this.generation) this.recordFailure(error);
          throw error;
        } finally {
          this.loggingIn = false;
        }
      },
    };
  }

  public detect(signal: AbortSignal): Promise<OAuthCredential | undefined> {
    if (this.detection) return this.detection;
    this.detection = this.detectOnce(signal);
    return this.detection;
  }

  private async detectOnce(callerSignal: AbortSignal): Promise<OAuthCredential | undefined> {
    const generation = this.generation;
    const signal = AbortSignal.any([callerSignal, this.lifecycle.signal, this.detectionCancellation.signal]);
    try {
      signal.throwIfAborted();
      if (this.loggingIn) throw new Error("Antigravity CLI status check was replaced by a newer attempt");
      const authenticated = await probeAgyAuthentication(this.agyPath, signal);
      signal.throwIfAborted();
      if (generation !== this.generation || this.loggingIn) throw new Error("Antigravity CLI status check was replaced by a newer attempt");
      this.status = authenticated ? "authenticated" : "unauthenticated";
      this.failure = undefined;
      return authenticated ? createAgyBridgeCredential() : undefined;
    } catch (error) {
      if (generation === this.generation) this.recordFailure(error);
      throw error;
    }
  }

  public close(): void {
    ++this.generation;
    this.status = "unknown";
    this.lifecycle.abort(new Error("Antigravity CLI bridge session has ended"));
  }

  private recordFailure(error: unknown): void {
    this.status = "unknown";
    this.failure = {
      time: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Could not check Antigravity CLI authentication status",
    };
  }
}
