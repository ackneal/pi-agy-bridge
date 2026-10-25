import assert from "node:assert/strict";
import test from "node:test";
import { AgyAuthentication } from "./auth.ts";

for (const outcome of ["success", "failure"] as const) {
  test(`backend switch rejects stale detection: ${outcome}`, async (t) => {
    let finish!: (value: boolean) => void;
    let fail!: (error: Error) => void;
    let oldSignal!: AbortSignal;
    const pending = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; });
    const auth = new AgyAuthentication({
      label: "old", login: async () => {},
      probe: (signal) => { oldSignal = signal; return pending; },
    }, async () => {});
    t.after(() => auth.close());
    const detection = auth.detect(new AbortController().signal);
    const rejected = assert.rejects(detection, /backend changed|old probe failed/);

    auth.setBackend({ label: "new", login: async () => {}, probe: async () => false });
    assert.equal(oldSignal.aborted, true);
    assert.equal(await auth.detect(new AbortController().signal), undefined);
    if (outcome === "success") finish(true);
    else fail(new Error("old probe failed"));
    await rejected;

    assert.equal(auth.status, "unauthenticated");
    assert.equal(auth.failure, undefined);
    assert.equal(auth.usage, undefined);
    assert.equal(auth.oauth.name, "new");
    assert.equal(auth.method.name, "new");
  });
}

test("backend switch cancels an in-flight login without returning an old credential", async (t) => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let oldSignal!: AbortSignal;
  const auth = new AgyAuthentication({
    label: "old", probe: async () => true,
    login: async ({ signal }) => { oldSignal = signal; await gate; },
  }, async () => {});
  t.after(() => { resume(); auth.close(); });
  const login = auth.oauth.login({ signal: new AbortController().signal, notify: () => {}, prompt: async () => "" });
  const rejected = assert.rejects(Promise.resolve(login), /backend changed/);
  await Promise.resolve();

  auth.setBackend({ label: "new", probe: async () => false, login: async () => {} });
  assert.equal(oldSignal.aborted, true);
  resume();
  await rejected;

  assert.equal(auth.status, "unknown");
  assert.equal(auth.failure, undefined);
  assert.equal(await auth.detect(new AbortController().signal), undefined);
});
