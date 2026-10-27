import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createAcpAuthenticationBackend } from "./auth.ts";

for (const row of [
  { mode: "catalog", login: false, error: undefined },
  { mode: "required", login: false, error: /Authentication required/ },
  { mode: "login", login: false, error: /Authentication required/ },
  { mode: "login", login: true, error: undefined },
  { mode: "required", login: true, error: /could not be confirmed/ },
  { mode: "hang", login: false, error: /timeout/ },
]) {
  test(`ACP auth ${row.mode} login=${row.login}`, async () => {
    const backend = createAcpAuthenticationBackend({ executable: process.execPath, cwd: process.cwd(), args: ["--experimental-strip-types", fileURLToPath(new URL("./discovery-fixture.ts", import.meta.url)), row.mode], requestTimeoutMs: 1500 });
    const signal = new AbortController().signal;
    const operation = row.login ? backend.login({ signal, notify() {}, async prompt(request) {
      assert.equal(request.type, "select");
      return "synthetic-auth";
    } }) : backend.probe(signal);
    if (row.error) await assert.rejects(operation, row.error);
    else await operation;
  });
}
