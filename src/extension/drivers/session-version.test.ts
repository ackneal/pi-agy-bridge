import assert from "node:assert/strict";
import test from "node:test";
import { prepareCliRuntime, resolveModelAndEffort } from "./cli/session.ts";
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
        get: async (...args: [string, string]) => {
          reads.push(args);
          throw stopAfterRead;
        },
        delete: async () => { throw new Error("Preparation must stop at lookup"); },
      },
      sync: {
        decide: () => { throw new Error("Preparation must stop at lookup"); },
      },
      installPlugin: async () => { throw new Error("Preparation must stop at lookup"); },
    };
    const options = { env: { AGY_BRIDGE_ENABLED: "1" } };

    const preparing = driver === "cli"
      ? prepareCliRuntime(model, { messages: [] }, [], options, process.cwd(), dependencies, session, resolveModelAndEffort(model.id), preparationId)
      : prepareAcpRuntime(model, { messages: [] }, [], options, { cwd: process.cwd(), resolve: async () => { throw new Error("Preparation must stop at lookup"); } }, dependencies, session, preparationId);
    await assert.rejects(preparing, stopAfterRead);

    assert.deepEqual(reads, [[session.piSessionId, version]]);
  });
}
