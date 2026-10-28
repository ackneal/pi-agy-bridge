import assert from "node:assert/strict";
import test from "node:test";
import { AgyAuthentication } from "./auth.ts";

for (const state of ["initial", "authenticated", "unauthenticated", "failed"] as const) {
  test(`skipped authentication probe preserves ${state} state`, async (t) => {
    let outcome: boolean | Error | undefined;
    const usage = { updatedAt: "now", groups: [] };
    const auth = new AgyAuthentication({
      label: "test backend",
      probe: async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      login: async (_interaction, onUsage) => { onUsage(usage); },
    }, async () => {});
    t.after(() => auth.close());
    const signal = new AbortController().signal;
    if (state === "authenticated") {
      await auth.oauth.login({ signal, notify: () => {}, prompt: async () => { throw new Error("Unexpected prompt"); } });
    } else if (state === "unauthenticated") {
      outcome = false;
      await auth.detect(signal);
    } else if (state === "failed") {
      outcome = new Error("backend unreachable");
      await assert.rejects(auth.detect(signal), /backend unreachable/);
    }
    const expected = {
      status: state === "authenticated" ? "authenticated" : state === "unauthenticated" ? "unauthenticated" : "unknown",
      failure: auth.failure,
      usage: state === "authenticated" ? usage : undefined,
    };
    outcome = undefined;

    assert.equal(await auth.detect(signal), undefined);
    assert.equal(await auth.detect(signal), undefined);

    assert.equal(auth.status, expected.status);
    assert.equal(auth.failure, expected.failure, "a skipped probe neither invents nor clears a real failure");
    assert.deepEqual(auth.usage, expected.usage);
    if (state !== "failed") assert.equal(auth.failure, undefined);
  });
}
