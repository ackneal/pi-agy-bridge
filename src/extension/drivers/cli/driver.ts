import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BridgeDriver, DriverAuthentication, DriverFailure, PrepareDriverInput } from "../types.ts";
import { DEFAULT_AGY_PLUGIN_DIR, ensureAgyPluginInstalled } from "../../discovery/plugin-install.ts";
import { discoverAgyModels } from "../../discovery/models.ts";
import { fetchAgyUsage } from "../../runtime/usage.ts";
import { detectCliExecutable } from "../../runtime/version.ts";
import { prepareDriverCwd } from "../cwd.ts";
import { createAuthenticationBackend } from "./auth.ts";
import { prepareRuntime, resolveModelAndEffort } from "./session.ts";
import { SessionMode } from "../types.ts";

export class Driver implements BridgeDriver {
  readonly id = "cli";
  readonly label = "Antigravity CLI";
  readonly sessionVersion = "cli:v1";
  readonly initialModels = [];
  readonly authentication: DriverAuthentication;
  pluginError: DriverFailure | undefined;

  constructor() {
    this.authentication = createAuthenticationBackend(
      () => this.detectExecutable(),
      () => prepareDriverCwd(this.id),
      () => this.installPlugin(DEFAULT_AGY_PLUGIN_DIR),
    );
  }

  detectExecutable(): string | undefined {
    return detectCliExecutable();
  }

  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void {
    resolveModelAndEffort(model.id, options, model.thinkingLevelMap);
  }

  async prepareSession(input: PrepareDriverInput) {
    input.options?.signal?.throwIfAborted();
    if (!input.session.ownsPreparation(input.preparationId)) {
      throw new Error("Antigravity runtime preparation was superseded");
    }

    const dependencies = {
      store: input.store,
      sync: input.sync,
      sessionVersion: this.sessionVersion,
      executable: this.detectExecutable(),
      installPlugin: (pluginDir: string) => this.installPlugin(pluginDir),
    };

    const selection = resolveModelAndEffort(input.model.id, input.options, input.model.thinkingLevelMap);
    const cwd = prepareDriverCwd(this.id);

    return prepareRuntime(
      input.model,
      input.context,
      input.messages,
      input.tools,
      input.options,
      cwd,
      dependencies,
      input.session,
      selection,
      input.preparationId,
      input.mode === SessionMode.Standalone,
    );
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
