import assert from "node:assert/strict";
import test from "node:test";
import { prepareRuntime, resolveModelAndEffort } from "./cli/session.ts";
import { prepareAcpRuntime } from "./acp/prepare.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { LiveSession } from "../session/session.ts";

for (const driver of ["cli", "acp"] as const) {
  test(`${driver} preparation passes the supplied session version unchanged`, async (t) => {
    const session = new LiveSession("pi-version-routing");
    t.after(() => session.dispose());
    const preparationId = session.beginPreparation();
    const model = parseModelsOutput("gemini-3.8-flash-high  Gemini 3.8 Flash (High)")[0]!;
    const version = "opaque-custom-format:v7";
    const stopAfterRead = new Error("stop after verifying state lookup");
    const reads: unknown[][] = [];
    const dependencies = {
      sessionVersion: version,
      store: {
        get: async (...args: [string, string | undefined, string]) => {
          reads.push(args);
          throw stopAfterRead;
        },
        delete: async () => { throw new Error("Preparation must stop at lookup"); },
      },
      sync: {
        decide: () => { throw new Error("Preparation must stop at lookup"); },
        getSyncedMessageCount: () => undefined,
      },
      installPlugin: async () => { throw new Error("Preparation must stop at lookup"); },
    };
    const options = { env: { AGY_BRIDGE_LOGIN_EPOCH: "login-epoch" } };

    const preparing = driver === "cli"
      ? prepareRuntime(model, { messages: [] }, [], options, undefined, dependencies, session, resolveModelAndEffort(model.id), preparationId)
      : prepareAcpRuntime(model, { messages: [] }, [], options, { acpPath: process.execPath }, dependencies, session, preparationId);
    await assert.rejects(preparing, stopAfterRead);

    assert.deepEqual(reads, [[session.piSessionId, "login-epoch", version]]);
  });
}
