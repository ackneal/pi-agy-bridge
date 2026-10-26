import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { LiveSession } from "../../session/session.ts";
import { prepareRuntime, resolveModelAndEffort } from "./session.ts";

for (const stage of ["before lookup", "after lookup"] as const) {
  for (const reason of ["abort", "supersede"] as const) {
    test(`preparation rejects ${reason} ${stage} before sync or installation`, async () => {
      const session = new LiveSession("cli-preparation");
      const preparationId = session.beginPreparation();
      const controller = new AbortController();
      const cancellation = new Error("test cancellation");
      const calls: string[] = [];
      const invalidate = () => {
        if (reason === "abort") controller.abort(cancellation);
        else session.beginPreparation();
      };
      if (stage === "before lookup") invalidate();

      try {
        await assert.rejects(prepareRuntime(
          { id: "test-model" } as Model<any>,
          { messages: [] },
          [],
          { signal: controller.signal },
          process.cwd(),
          {
            store: {
              get: async () => {
                calls.push("get");
                invalidate();
                return undefined;
              },
              delete: async () => { calls.push("delete"); },
            },
            sync: {
              decide: () => { throw new Error("sync must not run"); },
              getSyncedMessageCount: () => { throw new Error("sync must not run"); },
            },
            sessionVersion: "cli:v1",
            installPlugin: async () => { calls.push("install"); },
          },
          session,
          resolveModelAndEffort("test-model"),
          preparationId,
        ), reason === "abort" ? cancellation : {
          message: "Antigravity CLI runtime preparation was superseded",
        });
        assert.deepEqual(calls, stage === "before lookup" ? [] : ["get"]);
        assert.equal(session.activeProcess, null);
        assert.equal(session.activeMcpServer, null);
      } finally {
        await session.dispose();
      }
    });
  }
}
