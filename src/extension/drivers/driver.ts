import path from "node:path";
import type { AnyModel, Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import type { AgyBridgeConfig } from "../shared/types.ts";
import type { LiveSession } from "../session/session.ts";
import type { RuntimeSessionStore, RuntimeSessionSync } from "../session/session-state.ts";
import type { BridgeIPC } from "../bridge/bridge-ipc.ts";
import type { AgyAuthenticationBackend } from "../provider/auth.ts";
import { collectDoctorReport, type DoctorFailure } from "../provider/doctor.ts";
import { DEFAULT_AGY_PLUGIN_DIR, ensureAgyPluginInstalled } from "../discovery/plugin-install.ts";
import { discoverAgyModels } from "../discovery/models.ts";
import { defaultModelCatalog } from "../discovery/model-metadata.ts";
import { createCliAuthenticationBackend } from "./cli/auth.ts";
import { fetchAgyUsage, type AgyUsage } from "../runtime/usage.ts";
import { expandHome } from "../shared/paths.ts";
import { prepareRuntime, resolveModelAndEffort } from "./cli/session.ts";
import { prepareAcpRuntime } from "./acp/prepare.ts";
import { createAcpAuthenticationBackend } from "./acp/auth.ts";
import { discoverAcpModels } from "./acp/discovery.ts";
import { detectAcpExecutable, resolveAcpConnectionOptions, resolveAcpEffort } from "./acp/options.ts";
import { detectCliExecutable, resolveAgyExecutable } from "../runtime/version.ts";
import type { DriverId, DriverSession } from "./types.ts";

export interface PrepareDriverInput {
  model: Model<any>;
  context: Context;
  tools: readonly Tool[];
  options: SimpleStreamOptions | undefined;
  session: LiveSession;
  store: RuntimeSessionStore;
  sync: RuntimeSessionSync;
  preparationId: symbol;
  installPlugin: (pluginDir: string) => Promise<void>;
}

interface DriverDiagnostics {
  catalogModels: AnyModel[];
  authStatus: "authenticated" | "unauthenticated" | "unknown";
  authError: DoctorFailure | undefined;
  discoveryError: DoctorFailure | undefined;
  pluginError: DoctorFailure | undefined;
  usage: AgyUsage | undefined;
  usageError: DoctorFailure | undefined;
}

export interface BridgeDriver {
  readonly id: DriverId;
  readonly label: string;
  readonly authentication: AgyAuthenticationBackend;
  readonly initialModels: readonly AnyModel[];
  validateSelection(model: Model<any>, options: SimpleStreamOptions | undefined): void;
  prepareSession(input: PrepareDriverInput): Promise<{ proc: DriverSession; mcpServer: BridgeIPC; reconstructContext: boolean; modelId: string }>;
  discoverModels(signal: AbortSignal): Promise<AnyModel[]>;
  usage(signal: AbortSignal): Promise<AgyUsage | undefined>;
  doctor(input: DriverDiagnostics): Promise<string>;
  installPlugin(pluginDir: string): Promise<void>;
}

export function resolveDriverId(config?: AgyBridgeConfig): DriverId {
  if (config?.driver !== undefined) {
    if (config.driver !== "cli" && config.driver !== "acp") {
      throw new Error(`Unsupported Antigravity driver: ${String(config.driver)}`);
    }
    return config.driver;
  }

  const acpBin = detectAcpExecutable(config?.acpPath);
  if (acpBin) return "acp";

  const cliBin = detectCliExecutable(config?.agyPath);
  if (cliBin) return "cli";

  throw new Error("Neither Antigravity ACP nor Antigravity CLI executable found");
}

export function createBridgeDriver(config?: AgyBridgeConfig): BridgeDriver {
  const id = resolveDriverId(config);
  const label = id === "cli" ? "Antigravity CLI" : "Antigravity ACP";
  const acpAuthentication = () => createAcpAuthenticationBackend(resolveAcpConnectionOptions(config));

  return {
    id, label,
    initialModels: id === "acp" ? defaultModelCatalog() : [],
    authentication: id === "cli" ? createCliAuthenticationBackend(config?.agyPath) : {
      label,
      probe: async (signal) => { await acpAuthentication().probe(signal); return true; },
      login: (interaction) => acpAuthentication().login(interaction),
    },
    validateSelection(model, options) {
      if (id === "cli") resolveModelAndEffort(model.id, options, model.thinkingLevelMap);
      else resolveAcpEffort(model, options);
    },
    async prepareSession(input) {
      if (input.session.driverId !== id) await input.session.dispose({ preparationId: input.preparationId });
      input.options?.signal?.throwIfAborted();
      const dependencies = { store: input.store, sync: input.sync, installPlugin: input.installPlugin };
      if (id === "acp") return prepareAcpRuntime(input.model, input.context, input.tools, input.options, config, dependencies, input.session, input.preparationId);
      const selection = resolveModelAndEffort(input.model.id, input.options, input.model.thinkingLevelMap);
      return prepareRuntime(input.model, input.context, input.tools, input.options, config, dependencies, input.session, selection, input.preparationId);
    },
    discoverModels: (signal) => id === "cli"
      ? discoverAgyModels(config?.agyPath, signal)
      : discoverAcpModels(resolveAcpConnectionOptions(config), signal),
    usage: (signal) => id === "cli" ? fetchAgyUsage(config?.agyPath, signal) : Promise.resolve(undefined),
    async doctor(input) {
      if (id === "cli") {
        const pluginDir = config?.pluginDir ?? config?.agentDir;
        return collectDoctorReport({
          ...input, models: config?.models, agyPath: config?.agyPath,
          pluginDir: pluginDir ? path.resolve(expandHome(pluginDir)) : DEFAULT_AGY_PLUGIN_DIR,
        });
      }
      return [
        "Antigravity ACP bridge", "driver: acp", `authentication: ${input.authStatus}`,
        `models: ${input.catalogModels.length}`, "quota: not reported by ACP", "offload recovery: unsupported (PR1)",
        ...[input.authError, input.discoveryError].filter((error) => error !== undefined).map((error) => `! ${error.message}`),
      ].join("\n");
    },
    installPlugin(pluginDir) {
      if (id !== "cli") return Promise.reject(new Error("ACP does not use CLI plugins"));
      return ensureAgyPluginInstalled(config?.agyPath, pluginDir);
    },
  };
}
