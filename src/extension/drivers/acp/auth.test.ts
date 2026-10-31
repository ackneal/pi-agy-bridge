import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { createAcpAuthenticationBackend } from "./auth.ts";
import { Connection } from "./connection.ts";

for (const row of [
  { mode: "catalog", login: false, result: true },
  { mode: "advertised-auth", login: false, result: true },
  { mode: "required", login: false, result: false },
  { mode: "login", login: false, result: false },
  { mode: "browser", login: false, result: false },
  { mode: "fragmented-browser", login: false, result: false },
  { mode: "login", login: true, error: undefined },
  { mode: "required", login: true, error: /could not be confirmed/ },
  { mode: "failure", login: false, error: /synthetic failure/ },
  { mode: "hang", login: false, error: /timeout/ },
]) {
  test(`ACP auth ${row.mode} login=${row.login}`, async () => {
    const listeners = process.listenerCount("exit");
    const backend = createAcpAuthenticationBackend({ executable: process.execPath, cwd: process.cwd(), args: ["--experimental-strip-types", fileURLToPath(new URL("./discovery-fixture.ts", import.meta.url)), row.mode], requestTimeoutMs: 1500 });
    const signal = new AbortController().signal;
    const operation = row.login ? backend.login({ signal, notify() {}, async prompt(request) {
      assert.equal(request.type, "select");
      return "synthetic-auth";
    } }) : backend.probe(signal);
    if (row.error) await assert.rejects(operation, row.error);
    else if (row.login) await operation;
    else assert.equal(await operation, row.result);
    assert.equal(process.listenerCount("exit"), listeners, "probe and login must await process cleanup");
  });
}

test("ACP probe cancellation takes precedence over an authentication-required response", async (t) => {
  const controller = new AbortController();
  const cancelled = new Error("cancel auth check");
  t.mock.method(Connection.prototype, "start", async () => ({ protocolVersion: acp.PROTOCOL_VERSION }));
  t.mock.method(Connection.prototype, "request", async () => {
    controller.abort(cancelled);
    throw acp.RequestError.authRequired();
  });
  const backend = createAcpAuthenticationBackend({ executable: process.execPath, cwd: process.cwd() });

  await assert.rejects(backend.probe(controller.signal), (error) => error === cancelled);
});
