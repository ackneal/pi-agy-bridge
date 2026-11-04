import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { Driver } from "./driver.ts";
import { Connection } from "./connection.ts";

describe("AgyAcp Driver", () => {
  test("driver metadata and properties", () => {
    const driver = new Driver();
    assert.equal(driver.id, "cli-acp");
    assert.equal(driver.label, "Antigravity CLI ACP");
    assert.equal(driver.sessionVersion, "cli-acp:v1");
    assert.deepEqual(driver.initialModels, []);
  });

  describe("discovery and usage", () => {
    test("restores usage and executable-backed model discovery", async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "cli-acp-discovery-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const executable = path.join(directory, "agy");
      await writeFile(
        executable,
        '#!/bin/sh\nif [ "$1" = "models" ]; then printf "gemini-3.8-flash-high  Gemini 3.8 Flash (High)\\n"; else printf "Claude  Five hour  50%%\\n"; fi\n',
        { mode: 0o700 }
      );
      const driver = new Driver();
      t.mock.method(driver, "detectExecutable", () => executable);

      const usage = await driver.usage(new AbortController().signal);
      const models = await driver.discoverModels(new AbortController().signal);

      assert.ok(usage && usage.groups.length > 0);
      assert.equal(models[0]?.id, "gemini-3.8-flash");
      assert.equal(models[0]?.thinkingLevelMap?.high, "high");
    });
  });

  describe("authentication", () => {
    for (const authenticated of [false, true]) {
      test(`probe reports authenticated=${authenticated}`, async (t) => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "cli-acp-auth-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const previousHome = process.env.GEMINI_HOME;
        process.env.GEMINI_HOME = directory;
        t.after(() => {
          if (previousHome === undefined) delete process.env.GEMINI_HOME;
          else process.env.GEMINI_HOME = previousHome;
        });

        t.mock.method(Connection.prototype, "start", async () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
        }));
        t.mock.method(Connection.prototype, "request", async (method: string) => {
          if (method === acp.methods.agent.session.new) {
            if (!authenticated) throw acp.RequestError.authRequired();
            return { sessionId: "session-probe" };
          }
          if (method === acp.methods.agent.session.close) return {};
          throw new Error(`Unexpected method: ${method}`);
        });
        t.mock.method(Connection.prototype, "dispose", async () => {});

        const driver = new Driver();
        driver.detectExecutable = () => "/bin/agy";
        const onUsage = t.mock.fn();

        assert.equal(await driver.authentication.probe(new AbortController().signal, onUsage), authenticated);
      });
    }
  });

  describe("selection validation", () => {
    test("validates model and effort", () => {
      const driver = new Driver();
      assert.doesNotThrow(() =>
        driver.validateSelection({ id: "gemini-3.8-flash" } as any, { reasoningEffort: "high" } as any)
      );
      assert.throws(
        () => driver.validateSelection({ id: "gemini-3.8-flash" } as any, { reasoningEffort: "extreme" } as any),
        /Unsupported Antigravity reasoning effort: extreme/
      );
    });
  });
});
