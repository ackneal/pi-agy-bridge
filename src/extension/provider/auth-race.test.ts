import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { loginAgyAuthentication, probeAgyAuthentication } from "../runtime/auth.ts";
import { AgyAuthentication } from "./auth.ts";

function setup(t: TestContext, beforeLogin: () => Promise<void> = async () => {}) {
  const children: ReturnType<typeof createChild>[] = [];
  function createChild() {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => true,
    });
  }
  t.mock.method(cp, "spawn", (command: string, args: string[]) => {
    assert.equal(command, "/fake/agy");
    assert.deepEqual(args, ["--output-format", "json", "--print", "/usage"]);
    const child = createChild();
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  const auth = new AgyAuthentication({
    label: "Antigravity CLI",
    probe: (signal, onUsage) => probeAgyAuthentication("/fake/agy", signal, onUsage),
    login: (interaction, onUsage) => loginAgyAuthentication(interaction, "/fake/agy", onUsage),
  }, beforeLogin);
  t.after(() => {
    auth.close();
    for (const child of children) child.emit("close", 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    auth, children,
    finish(index: number) {
      const child = children[index]!;
      assert.equal(child.stdin.writableEnded, false);
      child.stdout.write('Quota:\nGemini Models  Weekly Limit Remaining 100%\n');
      child.emit("close", 0, null);
    },
  };
}

for (const action of ["close", "abort"] as const) {
  test(`${action} prevents a pending login from returning a credential`, async (t) => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const { auth, children } = setup(t, () => gate);
    const controller = new AbortController();
    const login = Promise.resolve(auth.oauth.login({
      signal: controller.signal, notify: () => {}, prompt: async () => "",
    }));
    const rejected = assert.rejects(login);
    t.after(resume);

    if (action === "close") auth.close();
    else controller.abort();
    resume();
    await rejected;

    assert.equal(children.length, 0);
    assert.equal(auth.status, "unknown");
  });
}

test("pending login blocks concurrent login and resolution with an old marker", async (t) => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const { auth, children, finish } = setup(t, () => gate);
  const signal = new AbortController().signal;
  const interaction = { signal, notify: () => {}, prompt: async () => "" };
  const login = auth.oauth.login(interaction);
  t.after(resume);

  await assert.rejects(Promise.resolve(auth.oauth.login(interaction)), /Antigravity CLI authentication is already in progress/);
  assert.equal(await auth.method.resolve({
    ctx: defaultProviderAuthContext(), signal,
    credential: { type: "api_key", env: { AGY_BRIDGE_ENABLED: "1" } },
  }), undefined);
  assert.equal(children.length, 0);

  resume();
  await Promise.resolve();
  finish(0);
  assert.equal((await login).type, "oauth");
});

test("login credentials and resolved environment do not depend on historical epochs", async (t) => {
  const { auth, children, finish } = setup(t);
  const signal = new AbortController().signal;
  const login = auth.oauth.login({ signal, notify: () => {}, prompt: async () => "" });
  await Promise.resolve();
  finish(0);
  assert.equal((await login).type, "oauth");

  for (const env of [
    { AGY_BRIDGE_ENABLED: "1" },
    { AGY_BRIDGE_ENABLED: "1", AGY_BRIDGE_LOGIN_EPOCH: "legacy-epoch" },
  ]) {
    const context = { ctx: defaultProviderAuthContext(), signal, credential: { type: "api_key" as const, env } };
    assert.deepEqual(await auth.method.check!(context), { type: "api_key", source: "Antigravity CLI" });
    assert.deepEqual(await auth.method.resolve(context), {
      auth: {}, source: "Antigravity CLI", env: { AGY_BRIDGE_ENABLED: "1" },
    });
  }
  assert.equal(children.length, 1);
});

test("pending failed login never returns a success credential", async (t) => {
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((_, reject) => { fail = reject; });
  const { auth, children } = setup(t, () => gate);
  let credentialReturned = false;
  const login = Promise.resolve(auth.oauth.login({
    signal: new AbortController().signal, notify: () => {}, prompt: async () => "",
  })).then(() => { credentialReturned = true; });
  const rejected = assert.rejects(login, /before login failed/);
  await Promise.resolve();
  assert.equal(credentialReturned, false);
  assert.equal(children.length, 0);
  fail(new Error("before login failed"));
  await rejected;
  assert.equal(credentialReturned, false);
});

for (const outcome of ["authenticated", "unauthenticated", "abort", "close", "manual", "failure"] as const) {
  test(`detect deduplicates in flight: ${outcome}`, async (t) => {
    const { auth, children, finish } = setup(t);
    const controller = new AbortController();
    const detection = auth.detect(controller.signal);
    const settled = detection.then(value => ({ value }), error => ({ error }));
    const concurrent = auth.detect(new AbortController().signal);
    const concurrentSettled = concurrent.then(value => ({ value }), error => ({ error }));
    assert.equal(children.length, 1);

    if (outcome === "authenticated") finish(0);
    else if (outcome === "unauthenticated") {
      children[0]!.stderr.write("Authentication required\n");
      children[0]!.emit("close", 0, null);
    } else if (outcome === "failure") children[0]!.emit("close", 1, null);
    else {
      if (outcome === "abort") controller.abort();
      if (outcome === "close") auth.close();
      if (outcome === "manual") {
        const login = auth.oauth.login({ signal: new AbortController().signal, notify: () => {}, prompt: async () => "" });
        await Promise.resolve();
        finish(1);
        await login;
      }
      finish(0);
    }

    const result = await settled;
    if (outcome === "authenticated") {
      assert.ok("value" in result && result.value?.type === "oauth");
      assert.equal(auth.status, "authenticated");
    } else if (outcome === "unauthenticated") {
      assert.deepEqual(result, { value: undefined });
      assert.equal(auth.status, "unauthenticated");
    } else {
      assert.ok("error" in result);
      if (outcome === "manual") assert.equal(auth.status, "authenticated");
      if (outcome === "failure") assert.ok(auth.failure);
    }
    const sharedResult = await concurrentSettled;
    if (outcome === "abort") {
      assert.ok("value" in sharedResult && sharedResult.value?.type === "oauth");
      assert.equal(auth.status, "authenticated");
      assert.equal(auth.failure, undefined);
    } else assert.deepEqual(sharedResult, result);

    const retry = auth.detect(new AbortController().signal);
    if (outcome === "close") {
      await assert.rejects(retry, /session has ended/);
    } else {
      const index = outcome === "manual" ? 2 : 1;
      assert.equal(children.length, index + 1);
      finish(index);
      assert.ok((await retry)?.type === "oauth");
    }
  });
}

test("slow detection leaves credential checks and resolution spawn-free", async (t) => {
  const { auth, children, finish } = setup(t);
  const signal = new AbortController().signal;
  const detection = auth.detect(signal);
  let settled = false;
  void detection.then(() => { settled = true; });
  children[0]!.stdout.write("Quota:\n");
  await Promise.resolve();
  assert.equal(settled, false, "a quota heading must wait for natural close");

  for (const enabled of [false, true]) {
    const credential = { type: "api_key" as const, env: { AGY_BRIDGE_ENABLED: enabled ? "1" : "0" } };
    const context = { ctx: defaultProviderAuthContext(), signal, credential };
    assert.deepEqual(await auth.method.check!(context), enabled ? { type: "api_key", source: "Antigravity CLI" } : undefined);
    assert.deepEqual(await auth.method.resolve(context), enabled ? {
      auth: {}, source: "Antigravity CLI", env: { AGY_BRIDGE_ENABLED: "1" },
    } : undefined);
    assert.equal(children.length, 1);
  }

  finish(0);
  assert.ok((await detection)?.type === "oauth");
});

for (const output of ["", "Remaining 100%\n"]) {
  test(`invalid quota leaves detection unknown: ${JSON.stringify(output)}`, async (t) => {
    const { auth, children } = setup(t);
    const detection = auth.detect(new AbortController().signal);
    const rejected = assert.rejects(detection, (error: Error) => {
      assert.match(error.message, /returned no quota data/);
      return true;
    });
    children[0]!.stdout.write(output);
    children[0]!.emit("close", 0, null);

    await rejected;
    assert.equal(auth.status, "unknown");
    assert.equal(children.length, 1);
  });
}

for (const caller of ["first", "second", "pre-aborted"] as const) {
  test(`caller cancellation is isolated: ${caller}`, async (t) => {
    const { auth, children, finish } = setup(t);
    const cancelled = new AbortController();
    const reason = new Error("caller cancelled");
    if (caller === "pre-aborted") cancelled.abort(reason);
    const first = auth.detect(caller === "first" ? cancelled.signal : new AbortController().signal);
    const second = auth.detect(caller === "first" ? new AbortController().signal : cancelled.signal);
    const rejected = assert.rejects(caller === "first" ? first : second, error => error === reason);

    cancelled.abort(reason);
    await rejected;
    assert.equal(children.length, 1);
    assert.equal(auth.status, "unknown");
    assert.equal(auth.failure, undefined);
    finish(0);
    assert.ok((await (caller === "first" ? second : first))?.type === "oauth");
    assert.equal(auth.status, "authenticated");
  });
}

for (const loginOutcome of ["success", "failure"] as const) {
  test(`stale detection cleanup preserves new probe after login ${loginOutcome}`, async (t) => {
    const { auth, children, finish } = setup(t, async () => {
      if (loginOutcome === "failure") throw new Error("login failed");
    });
    const signal = new AbortController().signal;
    const stale = assert.rejects(auth.detect(signal), { name: "AbortError" });
    const login = auth.oauth.login({ signal, notify: () => {}, prompt: async () => "" });
    await assert.rejects(auth.detect(signal), /replaced by a newer attempt/);
    if (loginOutcome === "success") {
      finish(1);
      await login;
    } else await assert.rejects(Promise.resolve(login), /login failed/);

    const fresh = auth.detect(signal);
    const index = children.length - 1;
    finish(0);
    await stale;
    const joined = auth.detect(signal);
    assert.equal(children.length, index + 1);
    finish(index);
    assert.equal(await fresh, await joined);
    assert.equal(auth.status, "authenticated");
    assert.equal(auth.failure, undefined);
  });
}
