import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgyUsage } from "../../runtime/usage.ts";
import type { BridgeDriver, DriverAuthentication, DriverInstallationProgress, PrepareDriverInput } from "../types.ts";
import { defaultModelCatalog } from "../../discovery/model-metadata.ts";
import { prepareDriverCwd } from "../cwd.ts";
import { createAuthenticationBackend } from "./auth.ts";
import { discoverModels } from "./discovery.ts";
import { detectExecutable, resolveConnectionOptions, resolveEffort } from "./options.ts";
import { prepareRuntime } from "./prepare.ts";
import { SessionMode } from "../types.ts";
import { ensureInstallation, findInstallation } from "./installation.ts";

export class Driver implements BridgeDriver {
  readonly id = "acp";
  readonly label = "Antigravity ACP";
  readonly sessionVersion = "acp:v1";
  readonly initialModels = defaultModelCatalog();
  readonly authentication: DriverAuthentication;
  onInstallationProgress: ((progress: DriverInstallationProgress) => void) | undefined;
  private readonly resolveInstallation: typeof ensureInstallation;

  constructor(resolveInstallation: typeof ensureInstallation = ensureInstallation) {
    this.resolveInstallation = resolveInstallation;
    this.authentication = {
      label: this.label,
      probe: async (signal) => {
        const options = await this.connectionOptions(signal);
        return createAuthenticationBackend(options).probe(signal);
      },
      login: async (interaction) => {
        const options = await this.connectionOptions(interaction.signal,
          (progress) => interaction.notify({ type: "progress", message: progress.message }));
        return createAuthenticationBackend(options).login(interaction);
      },
    };
  }

  private async connectionOptions(signal?: AbortSignal, onProgress?: (progress: DriverInstallationProgress) => void) {
    signal?.throwIfAborted();
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Antigravity ACP requires macOS or Linux; native Windows is not supported");
    const override = process.env.AGY_ACP_BIN?.trim();
    if (override) {
      const executable = detectExecutable();
      if (!executable) throw new Error(`AGY_ACP_BIN is not an executable file: ${override}. Fix its path and permissions, or unset it to use the managed ACP installation.`);
      return resolveConnectionOptions(executable);
    }

    const launch = await this.resolveInstallation({
      ...(signal ? { signal } : {}),
      onProgress: (progress) => {
        this.onInstallationProgress?.(progress);
        onProgress?.(progress);
      },
    });
    signal?.throwIfAborted();
    return { ...resolveConnectionOptions(launch.executable), args: launch.args };
  }

  detectExecutable(): string | undefined {
    return detectExecutable() ?? (process.env.AGY_ACP_BIN?.trim() ? undefined : findInstallation());
  }

  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void {
    resolveEffort(model, options);
  }

  async prepareSession(input: PrepareDriverInput) {
    input.options?.signal?.throwIfAborted();
    if (!input.session.ownsPreparation(input.preparationId)) throw new Error("ACP preparation superseded");
    const connection = {
      cwd: prepareDriverCwd("acp"),
      resolve: () => this.connectionOptions(input.options?.signal),
    };
    const dependencies = { store: input.store, sync: input.sync, sessionVersion: this.sessionVersion };
    return prepareRuntime(input.model, input.context, input.messages, input.tools, input.options, connection, dependencies, input.session, input.preparationId, input.mode === SessionMode.Standalone);
  }

  async discoverModels(signal: AbortSignal) {
    return discoverModels(await this.connectionOptions(signal), signal);
  }

  usage(_signal: AbortSignal): Promise<AgyUsage | undefined> {
    return Promise.resolve(undefined);
  }
}
