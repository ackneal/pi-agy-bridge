import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as acp from "@agentclientprotocol/sdk";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAuthenticationBackend as createAcpAuthenticationBackend } from "../../src/extension/drivers/acp/auth.ts";
import { Connection as AcpConnection, type ConnectionOptions as AcpConnectionOptions } from "../../src/extension/drivers/acp/connection.ts";
import { Driver as AcpDriver } from "../../src/extension/drivers/acp/driver.ts";
import { createLivePiSession } from "./pi-session.ts";
import { ScenarioFailure, ScenarioOutcome } from "./report.ts";
import { executionMode, localScenarioRestriction } from "./environment.ts";

export async function runAuthScenario(options: {
  id: "AUTH-probe" | "AUTH-noauth" | "AUTH-login" | "AUTH-login-cancel";
  connection: AcpConnectionOptions;
  directory: string;
  signal: AbortSignal;
  t: TestContext;
  evidence: unknown[];
}): Promise<void> {
  const { id, connection, signal, evidence, t } = options;
  const state = process.env.PI_AGY_LIVE_AUTH_STATE ?? "authenticated";
  const login = id === "AUTH-login" || id === "AUTH-login-cancel";
  const method = process.env.PI_AGY_LIVE_AUTH_METHOD;
  if (state !== "authenticated" && state !== "unauthenticated") {
    throw new ScenarioFailure("setup", "PI_AGY_LIVE_AUTH_STATE must be authenticated or unauthenticated");
  }
  if (process.env.PI_AGY_LIVE_MODE === "local") {
    const restriction = localScenarioRestriction(id);
    if (restriction) throw new ScenarioOutcome("SKIP", restriction);
    executionMode();
  } else if (process.env.PI_AGY_LIVE !== "1" || process.env.PI_AGY_LIVE_ISOLATED !== "1") {
    throw new ScenarioOutcome("SKIP", "Set PI_AGY_LIVE=1 and PI_AGY_LIVE_ISOLATED=1 in the dedicated disposable container");
  }
  if (id === "AUTH-noauth" && state !== "unauthenticated") {
    throw new ScenarioOutcome("SKIP", "AUTH-noauth requires externally configured PI_AGY_LIVE_AUTH_STATE=unauthenticated; no credentials will be modified");
  }
  if (id === "AUTH-probe" && state !== "authenticated") {
    throw new ScenarioOutcome("SKIP", "AUTH-probe requires externally configured PI_AGY_LIVE_AUTH_STATE=authenticated");
  }
  if (login && process.env.PI_AGY_LIVE_LOGIN !== "1") {
    throw new ScenarioOutcome("SKIP", "Set PI_AGY_LIVE_LOGIN=1 to consent to browser opening and writes to disposable backend credential storage");
  }
  if (login && !method?.trim()) {
    throw new ScenarioOutcome("SKIP", "Set PI_AGY_LIVE_AUTH_METHOD to an exact backend-advertised method ID; no method is selected automatically");
  }
  signal.throwIfAborted();

  // Forward production calls unchanged. Only allowlisted observations leave this scope.
  // Prototype instrumentation is scoped to the serial live scenario, not a replacement driver.
  const starts: boolean[] = [];
  const sessions: string[] = [];
  const browserBlockers: boolean[] = [];
  const rpcOutcomes: { method: string; success: boolean; code?: number }[] = [];
  const active = new Set<AcpConnection>();
  let sent = 0;
  let confirmed = 0;
  let chooser = false;
  const start = AcpConnection.prototype.start;
  const request = AcpConnection.prototype.request;
  const dispose = AcpConnection.prototype.dispose;
  const spawn = childProcess.spawn;
  const spawnMock = t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof spawn>) => {
    if (args[0] === connection.executable) {
      const supplied = args[2];
      browserBlockers.push(typeof supplied?.env?.BROWSER === "string" && supplied.env.BROWSER.includes("noninteractive-browser.js"));
    }
    return Reflect.apply(spawn, childProcess, args);
  }) as typeof spawn);
  syncBuiltinESMExports();
  const startMock = t.mock.method(AcpConnection.prototype, "start", function (this: AcpConnection, input?: AbortSignal) {
    // Test-only observation of the options actually supplied by the production auth path.
    const supplied = Reflect.get(this, "options") as AcpConnectionOptions;
    starts.push(supplied.allowInteractiveAuthentication === true);
    active.add(this);
    return start.call(this, input);
  });
  const requestMock = t.mock.method(AcpConnection.prototype, "request", async function <M extends acp.AgentRequestMethod>(
    this: AcpConnection, name: M, params: acp.AgentRequestParamsByMethod[M],
  ): Promise<acp.AgentRequestResponsesByMethod[M]> {
    if (name === acp.methods.agent.authenticate) sent++;
    try {
      const response = await request.call(this, name, params) as acp.AgentRequestResponsesByMethod[M];
      rpcOutcomes.push({ method: name, success: true });
      if (name === acp.methods.agent.authenticate) confirmed++;
      if (name === acp.methods.agent.session.new) sessions.push((response as acp.NewSessionResponse).sessionId);
      return response;
    } catch (error) {
      rpcOutcomes.push({ method: name, success: false, ...(error instanceof acp.RequestError ? { code: error.code } : {}) });
      throw error;
    }
  });
  const disposeMock = t.mock.method(AcpConnection.prototype, "dispose", async function (this: AcpConnection) {
    await dispose.call(this);
    assert.equal(this.isRunning, false, "Authentication process survived cleanup");
    active.delete(this);
  });
  const backend = createAcpAuthenticationBackend(connection);
  const probe = async (expected?: boolean) => {
    const offset = starts.length;
    const count = sessions.length;
    const spawnOffset = browserBlockers.length;
    let result: boolean;
    try {
      result = await backend.probe(signal);
    } catch {
      signal.throwIfAborted();
      throw new ScenarioFailure("transport", "Noninteractive authentication probe failed, not an unauthenticated result");
    }
    evidence.push({ probeSuccess: result, requestedInteractive: starts.slice(offset) });
    if (expected !== undefined) assert.equal(result, expected, "Unexpected real backend authentication state");
    assert.deepEqual(starts.slice(offset), [false], "Probe must request noninteractive authentication");
    assert.deepEqual(browserBlockers.slice(spawnOffset), [true], "Actual ACP subprocess must receive the production browser blocker, not an interactive browser");
    if (result) assert.ok(sessions.length > count, "Probe must confirm session/new success");
    assert.equal(active.size, 0, "Probe must dispose its connection");
    return result;
  };

  try {
    if (!login) {
      await probe(id === "AUTH-probe");
      // A successful probe does not prove that the backend attempted to open a browser.
      evidence.push({ browserEnforcementObserved: false });
      return;
    }

    const beforeCancellation = id === "AUTH-login-cancel" ? await probe() : undefined;
    const fixtureEvidence: unknown[] = [];
    const fixture = await createLivePiSession({
      cwd: connection.cwd, directory: options.directory, signal, evidence: fixtureEvidence,
      launch: { executable: connection.executable, args: connection.args ?? [] },
      model: new AcpDriver().initialModels[0]!,
      tool: defineTool({ name: "mcp__pi__auth_inert", label: "Auth fixture", description: "Never executed", parameters: Type.Object({}),
        execute: async () => { throw new ScenarioFailure("bridge", "Authentication fixture tool must never execute"); } }),
    });
    const cancellation = new AbortController();
    const interactionSignal = AbortSignal.any([signal, cancellation.signal]);
    const cancelled = new Error("Test-owned chooser cancellation");
    const before = sessions.length;
    let loginError: unknown;
    try {
      try {
        await fixture.session.modelRuntime.login("agy", "oauth", {
          signal: interactionSignal,
          notify: () => {},
          prompt: async prompt => {
            if (prompt.type !== "select") throw new ScenarioOutcome("INCONCLUSIVE", "Backend did not offer the ACP method chooser");
            chooser = true;
            // Labels and other auth payloads are deliberately not retained.
            evidence.push({ methodNames: prompt.options.map(entry => entry.id).filter(name => /^[a-zA-Z0-9_.-]+$/.test(name)), methodCount: prompt.options.length });
            if (!prompt.options.some(entry => entry.id === method)) {
              throw new ScenarioOutcome("SKIP", "PI_AGY_LIVE_AUTH_METHOD must exactly match an advertised method ID");
            }
            if (id === "AUTH-login-cancel") {
              cancellation.abort(cancelled);
              // Only the cancellation signal may reject login; a chooser error would mask a broken cancellation path.
              return new Promise<string>(() => {});
            }
            return method!;
          },
        });
      } catch (error) {
        loginError = error;
      }
      signal.throwIfAborted();
      if (loginError instanceof ScenarioOutcome) throw loginError;
      if (id === "AUTH-login-cancel") {
        assert.equal(sent, 0, "Cancelled chooser must not send authenticate");
        if (!chooser) {
          if (loginError) throw new ScenarioFailure("backend", "Login failed before reaching a cancellable method chooser");
          throw new ScenarioOutcome("INCONCLUSIVE", "Backend offered no cancellable method chooser; cancellation was not exercised");
        }
        assert.ok(cancellation.signal.aborted, "Chooser must abort the login controller");
        assert.ok(loginError, "Cancelled login must reject");
      } else {
        if (loginError) throw new ScenarioFailure("backend", "Pi OAuth login failed");
        if (!chooser) throw new ScenarioOutcome("INCONCLUSIVE", "Backend offered no method chooser; explicit authenticate was not exercised");
        assert.equal(sent, 1, "Pi login must send authenticate exactly once");
        assert.equal(confirmed, 1, "Backend must confirm authenticate");
        assert.ok(sessions.length > before, "Login must confirm subsequent session/new success");
      }
      assert.ok(starts.includes(true), "Pi login must request interactive authentication");
      // Pi may reject caller cancellation before the provider's finally has settled.
      // Observe natural disposal; do not force-close it and call that successful cancellation.
      const cleanupDeadline = Date.now() + 3000;
      while (active.size > 0 && Date.now() < cleanupDeadline) {
        signal.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(active.size, 0, "Login must naturally dispose its connection within the cleanup deadline");
    } finally {
      await fixture.close();
      evidence.push({ piFixtureCleanupSuccess: true });
    }
    await probe(id === "AUTH-login" ? true : beforeCancellation!);
  } catch (error) {
    if (error instanceof ScenarioOutcome || error instanceof ScenarioFailure) throw error;
    signal.throwIfAborted();
    if (error instanceof assert.AssertionError) evidence.push({ authAssertion: error.message });
    throw new ScenarioFailure("bridge", "Authentication scenario assertion or cleanup failed", error);
  } finally {
    try {
      const cleanup = await Promise.allSettled([...active].map(client => client.dispose()));
      if (cleanup.some(result => result.status === "rejected")) {
        throw new ScenarioFailure("transport", "Authentication connection cleanup failed");
      }
    } finally {
      evidence.push({ requestedInteractive: starts, browserBlockers, rpcOutcomes, sessionIds: sessions, authenticateCount: sent, authenticateSuccessCount: confirmed, remainingConnections: active.size });
      disposeMock.mock.restore();
      requestMock.mock.restore();
      startMock.mock.restore();
      spawnMock.mock.restore();
      syncBuiltinESMExports();
    }
  }
}
