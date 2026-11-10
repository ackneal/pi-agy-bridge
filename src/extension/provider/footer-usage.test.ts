import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FooterDataProvider } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/footer-data-provider.js";
import { FooterComponent } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
import { splitPromptUsage } from "./usage-accounting.ts";

function usage(input: number, output: number, cacheRead: number): Usage {
  return {
    input, output, cacheRead, cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const cases = [
  {
    name: "two calls keep context at 9195 instead of the 15355 aggregate",
    aggregate: usage(14490, 865, 0),
    lastCall: usage(8461, 734, 0),
    footerTokens: "↑14k ↓865",
    cacheHitRate: undefined,
  },
  {
    name: "thirty calls keep context at 64228 instead of the 1017768 aggregate",
    aggregate: usage(123355, 6774, 887639),
    lastCall: usage(3513, 1927, 58788),
    footerTokens: "↑123k ↓6.8k R888k CH94.4%",
    cacheHitRate: 94.36,
  },
];

for (const row of cases) {
  test(`Pi footer usage: ${row.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-footer-usage-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const agentDir = join(directory, "agent");
    const settingsManager = SettingsManager.inMemory();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model, "use the installed Pi static model catalog, without auth or discovery");
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().extensions, []);
    const sessionManager = SessionManager.inMemory(directory);
    const { session } = await createAgentSession({
      cwd: directory, agentDir, model, modelRuntime, resourceLoader,
      settingsManager, sessionManager, noTools: "all",
    });
    t.after(() => session.dispose());
    const footerData = new FooterDataProvider(directory);
    t.after(() => footerData.dispose());
    initTheme("dark", false);
    const footer = new FooterComponent(session, footerData);
    t.after(() => footer.dispose());
    const assistant: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: "Done." }],
      api: model.api, provider: model.provider, model: model.id,
      usage: row.lastCall, stopReason: "stop", timestamp: 1,
    };
    const remainder = splitPromptUsage(row.aggregate, row.lastCall);
    assert.ok(remainder);

    sessionManager.appendMessage(assistant);
    // Independent usage must count toward totals, but not replace the context/CH anchor.
    sessionManager.appendUsage("agy-prompt-remainder", model.provider, model.id, remainder);

    const expectedTokens = {
      input: row.aggregate.input, output: row.aggregate.output,
      cacheRead: row.aggregate.cacheRead, cacheWrite: row.aggregate.cacheWrite,
      total: row.aggregate.totalTokens,
    };
    const stats = session.getSessionStats();
    assert.deepEqual(stats.tokens, expectedTokens, "last call plus remainder counts the aggregate exactly once");
    assert.equal(stats.assistantMessages, 1);
    assert.equal(stats.contextUsage?.tokens, row.lastCall.totalTokens);
    assert.equal(session.getContextUsage()?.tokens, row.lastCall.totalTokens);
    const rendered = footer.render(240).map(stripVTControlCharacters).join("\n");
    assert.ok(rendered.includes(row.footerTokens), rendered);
    const contextDisplay = `${((row.lastCall.totalTokens / model.contextWindow) * 100).toFixed(1)}%/`;
    assert.ok(rendered.includes(contextDisplay), rendered);
    if (row.cacheHitRate !== undefined) {
      const promptTokens = row.lastCall.input + row.lastCall.cacheRead + row.lastCall.cacheWrite;
      assert.equal(Number(((row.lastCall.cacheRead / promptTokens) * 100).toFixed(2)), row.cacheHitRate);
      assert.ok(!rendered.includes("CH100"), rendered);
    }

    sessionManager.appendCompaction("Compacted conversation.", null, row.lastCall.totalTokens);

    assert.equal(session.getContextUsage()?.tokens, null);
    assert.deepEqual(session.getSessionStats().tokens, expectedTokens);
    assert.match(footer.render(240).map(stripVTControlCharacters).join("\n"), /\?\//);

    sessionManager.appendMessage({ ...assistant, timestamp: 2 });

    const recovered = session.getSessionStats();
    assert.equal(recovered.contextUsage?.tokens, row.lastCall.totalTokens);
    assert.deepEqual(recovered.tokens, {
      input: expectedTokens.input + row.lastCall.input,
      output: expectedTokens.output + row.lastCall.output,
      cacheRead: expectedTokens.cacheRead + row.lastCall.cacheRead,
      cacheWrite: expectedTokens.cacheWrite + row.lastCall.cacheWrite,
      total: expectedTokens.total + row.lastCall.totalTokens,
    });
    const recoveredFooter = footer.render(240).map(stripVTControlCharacters).join("\n");
    assert.ok(recoveredFooter.includes(contextDisplay), recoveredFooter);
    assert.ok(!recoveredFooter.includes("?/"), recoveredFooter);
    if (row.cacheHitRate !== undefined) assert.ok(recoveredFooter.includes("CH94.4%"), recoveredFooter);
  });
}
