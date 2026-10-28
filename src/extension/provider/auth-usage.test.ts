import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationRequiredError } from "../shared/types.ts";
import { AgyAuthentication } from "./auth.ts";

const quota = { updatedAt: "now", groups: [] };

for (const row of [
  { name: "quota confirms authentication without probing", usage: quota, authenticated: false, status: "authenticated", probes: 0 },
  { name: "no quota falls back to authenticated probe", authenticated: true, status: "authenticated", probes: 1 },
  { name: "no quota falls back to unauthenticated probe", authenticated: false, status: "unauthenticated", probes: 1 },
  { name: "authentication requirement clears quota", error: new AuthenticationRequiredError(), authenticated: true, status: "unauthenticated", probes: 0 },
  { name: "quota failure records usage error", error: new Error("quota unavailable"), authenticated: true, status: "unknown", probes: 0 },
  { name: "probe failure records authentication error", probeError: new Error("probe unavailable"), authenticated: true, status: "unknown", probes: 1 },
] as const) {
  test(`authentication refresh: ${row.name}`, async (t) => {
    const probe = t.mock.fn(async () => {
      if ("probeError" in row) throw row.probeError;
      return row.authenticated;
    });
    const auth = new AgyAuthentication({ label: "test", probe, login: async () => {} }, async () => {});
    t.after(() => auth.close());
    const usage = t.mock.fn(async () => {
      if ("error" in row) throw row.error;
      return "usage" in row ? row.usage : undefined;
    });

    const result = auth.refreshUsage(new AbortController().signal, { usage });
    if ("error" in row) await assert.rejects(result, row.error);
    else if ("probeError" in row) await assert.rejects(result, row.probeError);
    else assert.deepEqual(await result, "usage" in row ? row.usage : undefined);

    assert.equal(auth.status, row.status);
    assert.equal(usage.mock.callCount(), 1);
    assert.equal(probe.mock.callCount(), row.probes);
    assert.deepEqual(auth.usage, "usage" in row ? row.usage : undefined);
    assert.equal(auth.usageError?.message, "error" in row && !(row.error instanceof AuthenticationRequiredError) ? row.error.message : undefined);
    assert.equal(auth.failure?.message, "probeError" in row ? row.probeError.message : undefined);
  });
}

for (const capturesUsage of [false, true]) {
  test(`successful login clears previous quota error with captured usage=${capturesUsage}`, async (t) => {
    const auth = new AgyAuthentication({
      label: "test",
      probe: async () => false,
      login: async (_interaction, onUsage) => { if (capturesUsage) onUsage(quota); },
    }, async () => {});
    t.after(() => auth.close());
    const signal = new AbortController().signal;
    const error = new Error("quota unavailable");
    await assert.rejects(auth.refreshUsage(signal, { usage: async () => { throw error; } }), error);
    assert.equal(auth.usageError?.message, error.message);

    await auth.oauth.login({ signal, notify: () => {}, prompt: async () => { throw new Error("Unexpected prompt"); } });

    assert.equal(auth.status, "authenticated");
    assert.equal(auth.failure, undefined);
    assert.equal(auth.usageError, undefined);
    assert.deepEqual(auth.usage, capturesUsage ? quota : undefined);
  });
}

for (const replacement of ["cancel", "login", "backend", "close"] as const) {
  test(`authentication refresh ignores stale usage after ${replacement}`, async (t) => {
    let resolve!: (value: typeof quota) => void;
    const auth = new AgyAuthentication({ label: "test", probe: async () => false, login: async () => {} }, async () => {});
    t.after(() => auth.close());
    const controller = new AbortController();
    const refresh = auth.refreshUsage(controller.signal, { usage: () => new Promise((done) => { resolve = done; }) });

    if (replacement === "cancel") controller.abort(new Error("cancelled"));
    else if (replacement === "backend") auth.setBackend({ label: "new", probe: async () => false, login: async () => {} });
    else if (replacement === "close") auth.close();
    else await auth.oauth.login({ signal: controller.signal, notify: () => {}, prompt: async () => { throw new Error("Unexpected prompt"); } });
    resolve(quota);

    await assert.rejects(refresh);
    assert.equal(auth.usage, undefined);
    assert.equal(auth.status, replacement === "login" ? "authenticated" : "unknown");
    assert.equal(auth.usageError, undefined);
  });
}
