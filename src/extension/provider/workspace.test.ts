import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { CliDriver } from "../drivers/cli/driver.ts";
import { Bridge, streamAgyProvider } from "./provider.ts";

for (const row of [
  { name: "bound session workspace", cwd: "/workspace/project" },
  { name: "process directory before a session is bound", cwd: undefined },
]) {
  test(`runtime preparation does not receive the ${row.name}`, async (t) => {
    const driver = new CliDriver();
    const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
    const bridge = new Bridge(pi, driver);
    t.after(() => bridge.liveSessions.disposeAll());
    const sessionId = row.cwd
      ? bridge.piContextAdapter.bind(SessionManager.inMemory(row.cwd))
      : "unbound-session";
    const preparation = t.mock.method(driver, "prepareSession", async (_input: Parameters<CliDriver["prepareSession"]>[0]) => {
      throw new Error("Stopped after input capture");
    });
    const model = { id: "test-model", provider: "agy" } as Model<any>;

    const result = await streamAgyProvider(model, { messages: [], tools: [] }, { sessionId }, bridge).result();

    assert.equal(preparation.mock.callCount(), 1);
    assert.equal(Object.hasOwn(preparation.mock.calls[0]!.arguments[0], "cwd"), false);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "Stopped after input capture");
  });
}
