import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { AcpDriver } from "../drivers/acp/driver.ts";
import { CliDriver } from "../drivers/cli/driver.ts";
import { parseModelsOutput } from "../discovery/models.ts";
import { createAgyBridgeCredential } from "./auth.ts";
import { registerAuthHomeFixture } from "./auth-home-fixture.ts";
import { Bridge } from "./provider.ts";

for (const id of ["cli", "acp"] as const) {
  for (const authenticated of [false, true]) {
    test(`${id} background checks report authenticated=${authenticated} and clean up before returning`, async (t) => {
      const home = await registerAuthHomeFixture(t);
      const previous = { home: process.env.GEMINI_HOME, bin: process.env.AGY_ACP_BIN };
      process.env.GEMINI_HOME = home;
      delete process.env.AGY_ACP_BIN;
      t.after(() => {
        if (previous.home === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = previous.home;
        if (previous.bin === undefined) delete process.env.AGY_ACP_BIN; else process.env.AGY_ACP_BIN = previous.bin;
      });
      const authPath = path.join(home, "auth.json");
      await writeFile(authPath, JSON.stringify(authenticated ? { agy: { ...createAgyBridgeCredential(), driver: id } } : {}));
      let fixtureAuthenticated = authenticated;
      const executable = path.join(home, "agy");
      const writeCli = () => writeFile(executable, '#!/bin/sh\ncase "$1" in\n--version) echo 1.2.14;;\nmodels) printf "cached-model-high  Cached Model (High)\\n";;\n*) ' + (fixtureAuthenticated
        ? 'printf "Claude  Five hour  50%%\\n"'
        : 'printf "Authentication required. Please visit the URL to log in:\\n" >&2; while :; do sleep 1; done') + ';;\nesac\n', { mode: 0o700 });
      await writeCli();
      const driver = id === "cli" ? new CliDriver() : new AcpDriver(async () => ({
        executable: process.execPath,
        args: ["--experimental-strip-types", fileURLToPath(new URL("../drivers/acp/discovery-fixture.ts", import.meta.url)), fixtureAuthenticated ? "catalog" : "browser"],
      }));
      t.mock.method(driver, "detectExecutable", () => id === "cli" ? executable : undefined);
      const handlers = new Map<string, (...args: any[]) => any>();
      const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
      const messages: string[] = [];
      let provider!: Provider;
      const bridge = new Bridge({
        on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
        registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command.handler),
        registerProvider: (registered: Provider) => { provider = registered; },
        sendMessage: (message: { content: string }) => { messages.push(message.content); },
      } as unknown as ExtensionAPI, driver);
      const listeners = process.listenerCount("exit");
      bridge.start();
      t.after(async () => { await handlers.get("session_shutdown")!(); });
      const cached = parseModelsOutput("cached-model-high  Cached Model (High)");
      let refreshed!: () => void;
      const refresh = async () => {
        await provider.refreshModels!({
          stored: { models: cached }, allowNetwork: true, signal: new AbortController().signal,
          publish: async (publication) => {
            if (id === "acp" && !fixtureAuthenticated) assert.equal(publication.persist, undefined, "login must not replace the model cache");
            publication.update?.();
            return true;
          },
        });
        refreshed?.();
      };
      const ctx = { hasUI: false, sessionManager: SessionManager.inMemory(), modelRegistry: { refresh } } as unknown as ExtensionCommandContext;

      for (const reason of ["startup", "switch"]) {
        const finished = new Promise<void>((resolve) => { refreshed = resolve; });
        handlers.get("session_start")!({ reason }, ctx);
        await finished;
      }
      await commands.get("agy-bridge:doctor")!("", ctx);

      assert.match(messages.at(-1)!, authenticated ? /✓ Auth: authenticated/ : /x Auth: unauthenticated/);
      assert.doesNotMatch(messages.at(-1)!, /\nErrors\n/);
      assert.equal(process.listenerCount("exit"), listeners);
      if (authenticated) {
        const stored = JSON.parse(await readFile(authPath, "utf8"));
        assert.equal(stored.agy.loginEpoch, undefined);
      } else {
        assert.equal(JSON.parse(await readFile(authPath, "utf8")).agy, undefined);
        assert.match(messages.at(-1)!, /Run \/login/);
        assert.deepEqual(provider.getModels(), cached);
      }

      fixtureAuthenticated = true;
      await writeCli();
      await provider.auth.oauth!.login({
        signal: new AbortController().signal, notify: () => {},
        prompt: async () => { throw new Error("Cached fixture login must not prompt"); },
      });
      await commands.get("agy-bridge:doctor")!("", ctx);

      assert.match(messages.at(-1)!, /✓ Auth: authenticated/);
      assert.doesNotMatch(messages.at(-1)!, /\nErrors\n/);
      assert.equal(process.listenerCount("exit"), listeners);
    });
  }
}
