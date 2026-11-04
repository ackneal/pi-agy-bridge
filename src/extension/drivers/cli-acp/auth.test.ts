import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import type { AgyUsage } from "../../runtime/usage.ts";
import { createAuthenticationBackend, isAuthRequiredError } from "./auth.ts";
import { Connection } from "./connection.ts";

const mockUsage: AgyUsage = {
  updatedAt: "2026-11-04T12:00:00Z",
  groups: [
    {
      name: "Default",
      buckets: [
        {
          id: "claude-3.5",
          name: "Claude 3.5",
          window: "5h",
          remainingFraction: 0.5,
          resetTime: "2026-11-04T17:00:00Z",
        },
      ],
    },
  ],
};

describe("AgyAcp isAuthRequiredError", () => {
  for (const { label, error, expected } of [
    { label: "acp RequestError authRequired (-32000)", error: acp.RequestError.authRequired(), expected: true },
    { label: "error with 'Authentication required' message", error: new Error("Authentication required. Please visit URL:"), expected: true },
    { label: "error with 'not authenticated' message", error: new Error("User is not authenticated"), expected: true },
    { label: "generic RequestError (-32603)", error: new acp.RequestError(-32603, "Internal error"), expected: false },
    { label: "generic Error", error: new Error("network timeout"), expected: false },
    { label: "non-error primitive", error: "some string", expected: false },
  ]) {
    test(`${label} -> ${expected}`, () => {
      assert.equal(isAuthRequiredError(error), expected);
    });
  }
});

describe("AgyAcp Auth Backend probe", () => {
  test("returns false when executable is not detected", async () => {
    const backend = createAuthenticationBackend(() => undefined, () => "/tmp");
    const onUsage = () => {};
    assert.equal(await backend.probe(new AbortController().signal, onUsage), false);
  });

  for (const { label, sessionNewError, expected, expectUsage } of [
    {
      label: "session/new succeeds -> authenticated",
      sessionNewError: undefined,
      expected: true,
      expectUsage: true,
    },
    {
      label: "session/new throws authRequired -> unauthenticated",
      sessionNewError: acp.RequestError.authRequired(),
      expected: false,
      expectUsage: false,
    },
    {
      label: "session/new throws unauthenticated message -> unauthenticated",
      sessionNewError: new Error("Client is unauthenticated"),
      expected: false,
      expectUsage: false,
    },
  ]) {
    test(label, async (t) => {
      t.mock.method(Connection.prototype, "start", async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
      }));

      t.mock.method(Connection.prototype, "request", async (method: string) => {
        if (method === acp.methods.agent.session.new) {
          if (sessionNewError) throw sessionNewError;
          return { sessionId: "session-123" };
        }
        if (method === acp.methods.agent.session.close) {
          return {};
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      t.mock.method(Connection.prototype, "dispose", async () => {});

      let usageCalled = false;
      const backend = createAuthenticationBackend(
        () => "/bin/agy",
        () => "/tmp",
        async () => {
          usageCalled = true;
          return mockUsage;
        },
      );

      const onUsage = t.mock.fn();
      const result = await backend.probe(new AbortController().signal, onUsage);

      assert.equal(result, expected);
      assert.equal(onUsage.mock.callCount(), expectUsage ? 1 : 0);
      assert.equal(usageCalled, expectUsage);
    });
  }

  test("probe re-throws unexpected errors", async (t) => {
    t.mock.method(Connection.prototype, "start", async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
    }));
    t.mock.method(Connection.prototype, "request", async () => {
      throw new Error("Synthetic database explosion");
    });
    t.mock.method(Connection.prototype, "dispose", async () => {});

    const backend = createAuthenticationBackend(() => "/bin/agy", () => "/tmp");
    await assert.rejects(backend.probe(new AbortController().signal, () => {}), /Synthetic database explosion/);
  });

  test("probe cancellation takes precedence over authRequired", async (t) => {
    const controller = new AbortController();
    const cancelled = new Error("Auth cancelled by user");

    t.mock.method(Connection.prototype, "start", async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
    }));
    t.mock.method(Connection.prototype, "request", async () => {
      controller.abort(cancelled);
      throw acp.RequestError.authRequired();
    });
    t.mock.method(Connection.prototype, "dispose", async () => {});

    const backend = createAuthenticationBackend(() => "/bin/agy", () => "/tmp");
    await assert.rejects(backend.probe(controller.signal, () => {}), (err) => err === cancelled);
  });
});

describe("AgyAcp Auth Backend login", () => {
  test("throws if executable is not detected", async () => {
    const backend = createAuthenticationBackend(() => undefined, () => "/tmp");
    await assert.rejects(
      backend.login({ signal: new AbortController().signal, notify: () => {}, prompt: async () => "" }, () => {}),
      /Antigravity CLI executable not found/
    );
  });

  test("login selects oauth-personal and confirms via session/new", async (t) => {
    t.mock.method(Connection.prototype, "start", async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods: [
        { id: "oauth-personal", name: "Google Account", description: "Log in with Google" },
      ],
    }));

    const requestedMethods: string[] = [];
    t.mock.method(Connection.prototype, "request", async (method: string, params: any) => {
      requestedMethods.push(method);
      if (method === acp.methods.agent.authenticate) {
        assert.equal(params.methodId, "oauth-personal");
        return {};
      }
      if (method === acp.methods.agent.session.new) {
        return { sessionId: "session-login-1" };
      }
      if (method === acp.methods.agent.session.close) {
        return {};
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    t.mock.method(Connection.prototype, "dispose", async () => {});

    const onUsage = t.mock.fn();
    const backend = createAuthenticationBackend(
      () => "/bin/agy",
      () => "/tmp",
      async () => mockUsage
    );

    await backend.login(
      {
        signal: new AbortController().signal,
        notify: () => {},
        prompt: async (req) => {
          assert.equal(req.type, "select");
          return "oauth-personal";
        },
      },
      onUsage
    );

    assert.ok(requestedMethods.includes(acp.methods.agent.authenticate));
    assert.ok(requestedMethods.includes(acp.methods.agent.session.new));
    assert.equal(onUsage.mock.callCount(), 1);
  });

  test("login with gemini-api-key prompts for key", async (t) => {
    t.mock.method(Connection.prototype, "start", async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods: [
        { id: "gemini-api-key", name: "Gemini API key", description: "API Key" },
      ],
    }));

    let authenticatedPayload: any;
    t.mock.method(Connection.prototype, "request", async (method: string, params: any) => {
      if (method === acp.methods.agent.authenticate) {
        authenticatedPayload = params;
        return {};
      }
      if (method === acp.methods.agent.session.new) {
        return { sessionId: "session-login-key" };
      }
      if (method === acp.methods.agent.session.close) {
        return {};
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    t.mock.method(Connection.prototype, "dispose", async () => {});

    const backend = createAuthenticationBackend(() => "/bin/agy", () => "/tmp", async () => mockUsage);

    await backend.login(
      {
        signal: new AbortController().signal,
        notify: () => {},
        prompt: async (req) => {
          if (req.type === "select") return "gemini-api-key";
          if (req.type === "secret") return "secret-api-key-12345";
          throw new Error(`Unexpected prompt: ${req.type}`);
        },
      },
      () => {}
    );

    assert.deepEqual(authenticatedPayload, {
      methodId: "gemini-api-key",
      meta: { inBandKey: "secret-api-key-12345" },
    });
  });

  test("login throws when session/new confirmation fails", async (t) => {
    t.mock.method(Connection.prototype, "start", async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods: [{ id: "oauth-personal", name: "Google Account" }],
    }));

    t.mock.method(Connection.prototype, "request", async (method: string) => {
      if (method === acp.methods.agent.authenticate) return {};
      if (method === acp.methods.agent.session.new) throw new Error("Backend authentication rejected");
      throw new Error(`Unexpected method: ${method}`);
    });
    t.mock.method(Connection.prototype, "dispose", async () => {});

    const backend = createAuthenticationBackend(() => "/bin/agy", () => "/tmp");

    await assert.rejects(
      backend.login(
        {
          signal: new AbortController().signal,
          notify: () => {},
          prompt: async () => "oauth-personal",
        },
        () => {}
      ),
      /Antigravity ACP authentication could not be confirmed via session\/new/
    );
  });
});
