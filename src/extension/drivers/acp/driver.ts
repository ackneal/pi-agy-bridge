import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgyUsage } from "../../runtime/usage.ts";
import type { BridgeDriver, DriverAuthentication, PrepareDriverInput } from "../types.ts";
import { defaultModelCatalog } from "../../discovery/model-metadata.ts";
import { prepareDriverCwd } from "../cwd.ts";
import { createAcpAuthenticationBackend } from "./auth.ts";
import { discoverAcpModels } from "./discovery.ts";
import { detectAcpExecutable, resolveAcpConnectionOptions, resolveAcpEffort } from "./options.ts";
import { prepareAcpRuntime } from "./prepare.ts";
import { ensureAcpInstallation, findAcpInstallation, type AcpInstallProgress } from "./installation.ts";

export class AcpDriver implements BridgeDriver {
  readonly id = "acp";
  readonly label = "Antigravity ACP";
  readonly sessionVersion = "acp:v1";
  readonly initialModels = defaultModelCatalog();
  readonly authentication: DriverAuthentication;
  onInstallationProgress: ((progress: AcpInstallProgress) => void) | undefined;
  private readonly resolveInstallation: typeof ensureAcpInstallation;

  constructor(resolveInstallation: typeof ensureAcpInstallation = ensureAcpInstallation) {
    this.resolveInstallation = resolveInstallation;
    this.authentication = {
      label: this.label,
      probe: async (signal) => {
        const options = await this.connectionOptions(signal);
        return createAcpAuthenticationBackend(options).probe(signal);
      },
      login: async (interaction) => {
        const options = await this.connectionOptions(interaction.signal,
          (progress) => interaction.notify({ type: "progress", message: progress.message }));
        return createAcpAuthenticationBackend(options).login(interaction);
      },
    };
  }

  private async connectionOptions(signal?: AbortSignal, onProgress?: (progress: AcpInstallProgress) => void) {
    signal?.throwIfAborted();
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Antigravity ACP requires macOS or Linux; native Windows is not supported");
    const override = process.env.AGY_ACP_BIN?.trim();
    if (override) {
      const executable = detectAcpExecutable();
      if (!executable) throw new Error(`AGY_ACP_BIN is not an executable file: ${override}. Fix its path and permissions, or unset it to use the managed ACP installation.`);
      return resolveAcpConnectionOptions(executable);
    }

    const launch = await this.resolveInstallation({
      ...(signal ? { signal } : {}),
      onProgress: (progress) => {
        this.onInstallationProgress?.(progress);
        onProgress?.(progress);
      },
    });
    signal?.throwIfAborted();
    return { ...resolveAcpConnectionOptions(launch.executable), args: launch.args };
  }

  detectExecutable(): string | undefined {
    return detectAcpExecutable() ?? (process.env.AGY_ACP_BIN?.trim() ? undefined : findAcpInstallation());
  }

  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void {
    resolveAcpEffort(model, options);
  }

  async prepareSession(input: PrepareDriverInput) {
    input.options?.signal?.throwIfAborted();
    if (!input.session.ownsPreparation(input.preparationId)) throw new Error("ACP preparation superseded");
    const connection = {
      cwd: prepareDriverCwd("acp"),
      resolve: () => this.connectionOptions(input.options?.signal),
    };
    const dependencies = { store: input.store, sync: input.sync, sessionVersion: this.sessionVersion };
    return prepareAcpRuntime(input.model, input.context, input.tools, input.options, connection, dependencies, input.session, input.preparationId);
  }

  async discoverModels(signal: AbortSignal) {
    return discoverAcpModels(await this.connectionOptions(signal), signal);
  }

  usage(_signal: AbortSignal): Promise<AgyUsage | undefined> {
    return Promise.resolve(undefined);
  }
}
