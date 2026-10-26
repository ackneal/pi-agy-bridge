import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BridgeDriver, DriverDiagnostics, DriverFailure, PrepareDriverInput } from "../types.ts";
import { collectDoctorReport } from "../../provider/doctor.ts";
import { DEFAULT_AGY_PLUGIN_DIR, ensureAgyPluginInstalled } from "../../discovery/plugin-install.ts";
import { discoverAgyModels } from "../../discovery/models.ts";
import { fetchAgyUsage } from "../../runtime/usage.ts";
import { detectCliExecutable } from "../../runtime/version.ts";
import { prepareDriverCwd } from "../cwd.ts";
import { createCliAuthenticationBackend } from "./auth.ts";
import { prepareCliRuntime, resolveModelAndEffort } from "./session.ts";

export class CliDriver implements BridgeDriver {
  readonly id = "cli";
  readonly label = "Antigravity CLI";
  readonly sessionVersion = "cli:v1";
  readonly initialModels = [];
  readonly authentication;
  private pluginError: DriverFailure | undefined;

  constructor() {
    this.authentication = createCliAuthenticationBackend(() => this.detectExecutable());
  }

  detectExecutable(): string | undefined {
    return detectCliExecutable();
  }

  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void {
    resolveModelAndEffort(model.id, options, model.thinkingLevelMap);
  }

  async prepareSession(input: PrepareDriverInput) {
    if (input.session.driverId !== undefined && input.session.driverId !== this.id) {
      await input.session.dispose({ preparationId: input.preparationId });
    }
    input.options?.signal?.throwIfAborted();

    const dependencies = {
      store: input.store, sync: input.sync, sessionVersion: this.sessionVersion, executable: this.detectExecutable(),
      installPlugin: (pluginDir: string) => this.installPlugin(pluginDir),
    };
    const selection = resolveModelAndEffort(input.model.id, input.options, input.model.thinkingLevelMap);
    const cwd = prepareDriverCwd(this.id);
    return prepareCliRuntime(input.model, input.context, input.tools, input.options, cwd, dependencies, input.session, selection, input.preparationId);
  }

  discoverModels(signal: AbortSignal) {
    return discoverAgyModels(this.detectExecutable(), signal);
  }

  usage(signal: AbortSignal) {
    return fetchAgyUsage(this.detectExecutable(), signal);
  }

  doctor(input: DriverDiagnostics): Promise<string> {
    return collectDoctorReport({
      ...input, pluginError: this.pluginError, agyPath: this.detectExecutable(),
      pluginDir: DEFAULT_AGY_PLUGIN_DIR,
    });
  }

  async installPlugin(pluginDir: string): Promise<void> {
    try {
      await ensureAgyPluginInstalled(this.detectExecutable(), pluginDir);
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
