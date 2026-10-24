import path from "node:path";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgyBridgeConfig } from "../../shared/types.ts";
import type { BridgeDriver, DriverDiagnostics, DriverFailure, PrepareDriverInput } from "../types.ts";
import { collectDoctorReport } from "../../provider/doctor.ts";
import { DEFAULT_AGY_PLUGIN_DIR, ensureAgyPluginInstalled } from "../../discovery/plugin-install.ts";
import { discoverAgyModels } from "../../discovery/models.ts";
import { fetchAgyUsage } from "../../runtime/usage.ts";
import { detectCliExecutable } from "../../runtime/version.ts";
import { expandHome } from "../../shared/paths.ts";
import { createCliAuthenticationBackend } from "./auth.ts";
import { prepareRuntime, resolveModelAndEffort } from "./session.ts";

export class CliDriver implements BridgeDriver {
  readonly id = "cli";
  readonly label = "Antigravity CLI";
  readonly sessionVersion = "cli:v1";
  readonly initialModels = [];
  readonly authentication;
  private pluginError: DriverFailure | undefined;

  private readonly config: AgyBridgeConfig | undefined;

  constructor(config?: AgyBridgeConfig) {
    this.config = config;
    this.authentication = createCliAuthenticationBackend(config?.agyPath);
  }

  detectExecutable(): string | undefined {
    return detectCliExecutable(this.config?.agyPath);
  }

  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void {
    resolveModelAndEffort(model.id, options, model.thinkingLevelMap);
  }

  async prepareSession(input: PrepareDriverInput) {
    if (input.session.driverId !== this.id) await input.session.dispose({ preparationId: input.preparationId });
    input.options?.signal?.throwIfAborted();

    const dependencies = {
      store: input.store, sync: input.sync, sessionVersion: this.sessionVersion,
      installPlugin: (pluginDir: string) => this.installPlugin(pluginDir),
    };
    const selection = resolveModelAndEffort(input.model.id, input.options, input.model.thinkingLevelMap);
    return prepareRuntime(input.model, input.context, input.tools, input.options, this.config, dependencies, input.session, selection, input.preparationId);
  }

  discoverModels(signal: AbortSignal) {
    return discoverAgyModels(this.config?.agyPath, signal);
  }

  usage(signal: AbortSignal) {
    return fetchAgyUsage(this.config?.agyPath, signal);
  }

  doctor(input: DriverDiagnostics): Promise<string> {
    const pluginDir = this.config?.pluginDir ?? this.config?.agentDir;
    return collectDoctorReport({
      ...input, pluginError: this.pluginError, models: this.config?.models, agyPath: this.config?.agyPath,
      pluginDir: pluginDir ? path.resolve(expandHome(pluginDir)) : DEFAULT_AGY_PLUGIN_DIR,
    });
  }

  async installPlugin(pluginDir: string): Promise<void> {
    try {
      await ensureAgyPluginInstalled(this.config?.agyPath, pluginDir);
      this.pluginError = undefined;
    } catch (error) {
      this.pluginError = {
        time: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }
}
