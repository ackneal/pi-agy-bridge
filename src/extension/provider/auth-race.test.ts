import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
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
    assert.deepEqual(args, ["--print", "/usage"]);
    const child = createChild();
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  const auth = new AgyAuthentication("/fake/agy", beforeLogin);
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
      assert.equal(child.stdin.writableEnded, true);
      child.stdout.write('Quota:\n  Limit Remaining 100%\n');
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

test("successful logins return unique epochs and resolve forwards only nonempty epochs without spawning", async (t) => {
  const { auth, children, finish } = setup(t);
  const signal = new AbortController().signal;
  const epochs: string[] = [];
  for (let index = 0; index < 2; index++) {
    const login = auth.oauth.login({ signal, notify: () => {}, prompt: async () => "" });
    await Promise.resolve();
    finish(index);
    const credential = await login;
    assert.ok(credential.type === "oauth");
    assert.equal(credential.agyBridge, true);
    const epoch = credential.loginEpoch as string;
    assert.match(epoch!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    epochs.push(epoch!);
  }
  assert.notEqual(epochs[0], epochs[1]);
  for (const epoch of [undefined, "", epochs[0]]) {
    const env = { AGY_BRIDGE_ENABLED: "1", ...(epoch === undefined ? {} : { AGY_BRIDGE_LOGIN_EPOCH: epoch }) };
    const credential = { type: "api_key" as const, env };
    const context = { ctx: defaultProviderAuthContext(), signal, credential };
    assert.deepEqual(await auth.method.check!(context), { type: "api_key", source: "Antigravity CLI CLI" });
    assert.deepEqual(await auth.method.resolve(context), {
      auth: {}, source: "Antigravity CLI CLI",
      env: { AGY_BRIDGE_ENABLED: "1", ...(epoch ? { AGY_BRIDGE_LOGIN_EPOCH: epoch } : {}) },
    });
    assert.equal(children.length, 2);
  }
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
  test(`detect probes once: ${outcome}`, async (t) => {
    const { auth, children, finish } = setup(t);
    const controller = new AbortController();
    const detection = auth.detect(controller.signal);
    const settled = detection.then(value => ({ value }), error => ({ error }));
    assert.equal(auth.detect(controller.signal), detection);
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
      assert.ok("value" in result && result.value?.agyBridge === true);
      assert.equal(auth.status, "authenticated");
    } else if (outcome === "unauthenticated") {
      assert.deepEqual(result, { value: undefined });
      assert.equal(auth.status, "unauthenticated");
    } else {
      assert.ok("error" in result);
      if (outcome === "manual") assert.equal(auth.status, "authenticated");
      if (outcome === "failure") assert.ok(auth.failure);
    }
    assert.equal(auth.detect(controller.signal), detection);
    assert.equal(children.length, outcome === "manual" ? 2 : 1);
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
    assert.deepEqual(await auth.method.check!(context), enabled ? { type: "api_key", source: "Antigravity CLI CLI" } : undefined);
    assert.deepEqual(await auth.method.resolve(context), enabled ? {
      auth: {}, source: "Antigravity CLI CLI", env: { AGY_BRIDGE_ENABLED: "1" },
    } : undefined);
    assert.equal(children.length, 1);
  }

  finish(0);
  assert.ok((await detection)?.agyBridge);
});

for (const output of ["", "Remaining 100%\n"]) {
  test(`invalid quota leaves detection unknown without retry: ${JSON.stringify(output)}`, async (t) => {
    const { auth, children } = setup(t);
    const detection = auth.detect(new AbortController().signal);
    const rejected = assert.rejects(detection, (error: Error) => {
      assert.ok(error.message.startsWith(`Could not determine Antigravity CLI authentication status (exitCode=0, signal=none, stdoutBytes=${Buffer.byteLength(output)}, stderrBytes=0)`));
      return true;
    });
    children[0]!.stdout.write(output);
    children[0]!.emit("close", 0, null);

    await rejected;
    assert.equal(auth.status, "unknown");
    assert.equal(children.length, 1);
  });
}
