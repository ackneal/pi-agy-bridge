import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BridgeConfig } from "../../shared/types.ts";
import type { AgyUsage } from "../../runtime/usage.ts";
import type { BridgeDriver, DriverAuthentication, DriverDiagnostics, PrepareDriverInput } from "../types.ts";
import { defaultModelCatalog } from "../../discovery/model-metadata.ts";
import { createAcpAuthenticationBackend } from "./auth.ts";
import { discoverAcpModels } from "./discovery.ts";
import { detectAcpExecutable, resolveAcpConnectionOptions, resolveAcpEffort } from "./options.ts";
import { prepareAcpRuntime } from "./prepare.ts";

export class AcpDriver implements BridgeDriver {
  readonly id = "acp";
  readonly label = "Antigravity ACP";
  readonly sessionVersion = "acp:v1";
  readonly initialModels = defaultModelCatalog();
  readonly authentication: DriverAuthentication;

  private readonly config: BridgeConfig | undefined;

  constructor(config?: BridgeConfig) {
    this.config = config;
    const authentication = () => createAcpAuthenticationBackend(resolveAcpConnectionOptions(this.config));
    this.authentication = {
      label: this.label,
      probe: async (signal) => { await authentication().probe(signal); return true; },
      login: (interaction) => authentication().login(interaction),
    };
  }

  detectExecutable(): string | undefined {
    return detectAcpExecutable(this.config?.acpPath);
  }

  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void {
    resolveAcpEffort(model, options);
  }

  async prepareSession(input: PrepareDriverInput) {
    if (input.session.driverId !== this.id) await input.session.dispose({ preparationId: input.preparationId });
    input.options?.signal?.throwIfAborted();

    const dependencies = { store: input.store, sync: input.sync, sessionVersion: this.sessionVersion };
    return prepareAcpRuntime(input.model, input.context, input.tools, input.options, this.config, dependencies, input.session, input.preparationId);
  }

  discoverModels(signal: AbortSignal) {
    return discoverAcpModels(resolveAcpConnectionOptions(this.config), signal);
  }

  usage(_signal: AbortSignal): Promise<AgyUsage | undefined> {
    return Promise.resolve(undefined);
  }

  async doctor(input: DriverDiagnostics): Promise<string> {
    return [
      "Antigravity ACP bridge", "driver: acp", `authentication: ${input.authStatus}`,
      `models: ${input.catalogModels.length}`, "quota: not reported by ACP", "offload recovery: unsupported (PR1)",
      ...[input.authError, input.discoveryError].filter((error) => error !== undefined).map((error) => `! ${error.message}`),
    ].join("\n");
  }
}
