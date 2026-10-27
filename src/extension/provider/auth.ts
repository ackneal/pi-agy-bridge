import { randomUUID } from "node:crypto";
import type { ApiKeyAuth, Credential, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { AgyUsage } from "../runtime/usage.ts";
import type { DriverAuthentication, DriverFailure } from "../drivers/types.ts";

const year = 365 * 24 * 60 * 60 * 1000;
const prefix = "agy-bridge:";

export function createAgyBridgeCredential(loginEpoch: string = randomUUID()): OAuthCredential {
  if (!loginEpoch.trim()) throw new Error("Antigravity CLI authentication session is no longer valid");
  return { type: "oauth", access: "", refresh: "", expires: Date.now() + year, agyBridge: true, loginEpoch };
}

export function isAgyBridgeEnabled(credential: Credential | undefined): boolean {
  if (credential?.type === "api_key") {
    return credential.env?.AGY_BRIDGE_ENABLED === "1" || getAgyBridgeAuthEnvironment(credential.key) !== undefined;
  }
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

/** Pi stores consent to use the bridge, not Antigravity CLI's authentication tokens. */
export class AgyAuthentication {
  public status: "authenticated" | "unauthenticated" | "unknown" = "unknown";
  public failure: DriverFailure | undefined;
  public usage: AgyUsage | undefined;
  public readonly method: ApiKeyAuth;
  public readonly oauth: OAuthAuth;
  private detection: Promise<OAuthCredential | undefined> | undefined;
  private detectionCancellation = new AbortController();
  private readonly lifecycle = new AbortController();
  private generation = 0;
  private loggingIn = false;

  private backend: DriverAuthentication;

  constructor(backend: DriverAuthentication, beforeLogin: () => Promise<void>) {
    this.backend = backend;
    const self = this;
    this.method = {
      get name() { return self.backend.label; },
      check: async ({ credential, signal }) => {
        signal.throwIfAborted();
        return isAgyBridgeEnabled(credential)
          ? { type: "api_key", source: self.backend.label }
          : undefined;
      },
      resolve: async ({ credential, signal }) => {
        if (!isAgyBridgeEnabled(credential) || self.loggingIn) return undefined;
        signal.throwIfAborted();
        self.lifecycle.signal.throwIfAborted();

        const keyEnv = getAgyBridgeAuthEnvironment(credential?.key);
        const epoch = credential?.env?.AGY_BRIDGE_LOGIN_EPOCH ?? keyEnv?.AGY_BRIDGE_LOGIN_EPOCH;
        return {
          auth: {},
          env: { AGY_BRIDGE_ENABLED: "1", ...(typeof epoch === "string" && epoch.length > 0 ? { AGY_BRIDGE_LOGIN_EPOCH: epoch } : {}) },
          source: self.backend.label,
        };
      },
    };
    this.oauth = {
      get name() { return self.backend.label; },
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
        const generation = ++this.generation;
        this.detection = undefined;
        this.detectionCancellation.abort(new Error("Antigravity CLI status check was replaced by a newer attempt"));
        this.detectionCancellation = new AbortController();
        this.status = "unknown";
        const signal = AbortSignal.any([interaction.signal, this.lifecycle.signal, this.detectionCancellation.signal]);
        try {
          signal.throwIfAborted();
          await beforeLogin();
          signal.throwIfAborted();
          interaction.notify({ type: "progress", message: `Checking ${this.backend.label} authentication status` });
          let capturedUsage: AgyUsage | undefined;
          await this.backend.login(
            { ...interaction, signal } satisfies ProviderAuthInteraction,
            (usage) => { capturedUsage = usage; }
          );
          signal.throwIfAborted();
          if (generation !== this.generation) throw new Error("Antigravity CLI authentication was replaced by a newer attempt");
          this.status = "authenticated";
          this.failure = undefined;
          if (capturedUsage) {
            this.usage = capturedUsage;
          }
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

  public setBackend(backend: DriverAuthentication): void {
    ++this.generation;
    this.detectionCancellation.abort(new Error("Antigravity authentication backend changed"));
    this.detectionCancellation = new AbortController();
    this.backend = backend;
    this.status = "unknown";
    this.usage = undefined;
    this.failure = undefined;
    this.detection = undefined;
  }

  public async detect(signal: AbortSignal): Promise<OAuthCredential | undefined> {
    signal.throwIfAborted();
    this.lifecycle.signal.throwIfAborted();
    if (this.loggingIn) throw new Error("Antigravity CLI status check was replaced by a newer attempt");

    if (!this.detection) {
      const detection = this.detectOnce().finally(() => {
        if (this.detection === detection) this.detection = undefined;
      });
      this.detection = detection;
    }

    const detection = this.detection;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      detection.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private async detectOnce(): Promise<OAuthCredential | undefined> {
    const generation = this.generation;
    const signal = AbortSignal.any([this.lifecycle.signal, this.detectionCancellation.signal]);
    try {
      signal.throwIfAborted();
      if (this.loggingIn) throw new Error("Antigravity CLI status check was replaced by a newer attempt");
      let capturedUsage: AgyUsage | undefined;
      const authenticated = await this.backend.probe(
        signal,
        (usage) => { capturedUsage = usage; }
      );
      signal.throwIfAborted();
      if (generation !== this.generation || this.loggingIn) throw new Error("Antigravity CLI status check was replaced by a newer attempt");
      this.status = authenticated ? "authenticated" : "unauthenticated";
      this.failure = undefined;
      if (authenticated && capturedUsage) {
        this.usage = capturedUsage;
      }
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
