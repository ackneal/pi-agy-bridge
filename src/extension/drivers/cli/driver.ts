import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BridgeDriver, DriverAuthentication, DriverFailure, PrepareDriverInput } from "../types.ts";
import { ensureAgyPluginInstalled } from "../../discovery/plugin-install.ts";
import { discoverAgyModels } from "../../discovery/models.ts";
import { fetchAgyUsage } from "../../runtime/usage.ts";
import { detectCliExecutable } from "../../runtime/version.ts";
import { loginAgyAuthentication, probeAgyAuthentication } from "../../runtime/auth.ts";
import { prepareDriverCwd } from "../cwd.ts";
import { prepareRuntime, resolveModelAndEffort } from "./session.ts";
import { SessionMode } from "../types.ts";

export class Driver implements BridgeDriver {
  readonly id = "cli";
  readonly label = "Antigravity CLI";
  readonly sessionVersion = "cli:v1";
  readonly initialModels = [];
  readonly authentication;
  pluginError: DriverFailure | undefined;

  constructor() {
    this.authentication = {
      label: this.label,
      probe: (signal, onUsage) => probeAgyAuthentication(this.detectExecutable(), signal, onUsage),
      login: (interaction, onUsage) => loginAgyAuthentication(interaction, this.detectExecutable(), onUsage),
    } satisfies DriverAuthentication;
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
    return prepareRuntime(input.model, input.context, input.tools, input.options, cwd, dependencies, input.session, selection, input.preparationId, input.mode === SessionMode.Standalone);
  }

  discoverModels(signal: AbortSignal) {
    return discoverAgyModels(this.detectExecutable(), signal);
  }

  usage(signal: AbortSignal) {
    return fetchAgyUsage(this.detectExecutable(), signal);
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
