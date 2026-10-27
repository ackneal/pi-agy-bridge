import assert from "node:assert/strict";
import { test } from "node:test";
import { compact } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";

type Preparation = Parameters<typeof compact>[0];
type StreamFn = NonNullable<Parameters<typeof compact>[7]>;
const model = { id: "summary", provider: "test", api: "test", reasoning: false, maxTokens: 1024 } as Model<any>;

function response(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "summary" }], api: "test", provider: "test", model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 1,
  };
}

function preparation(): Preparation {
  return {
    firstKeptEntryId: "kept",
    messagesToSummarize: [{ role: "user", content: "older", timestamp: 1 }],
    turnPrefixMessages: [{ role: "user", content: "turn prefix", timestamp: 2 }],
    isSplitTurn: true, tokensBefore: 100,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
  };
}

function mockStream(message: AssistantMessage): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    stream.end(message);
    return stream;
  };
}

test("Pi 1.4 split-turn summaries retain instructions without fixed output caps", async () => {
  const calls: Array<{ context: Parameters<StreamFn>[1]; options: SimpleStreamOptions | undefined }> = [];
  const streamFn: StreamFn = (selected, context, options) => {
    calls.push({ context, options });
    return mockStream(response())(selected, context, options);
  };
  const result = await compact(preparation(), model, undefined, undefined, "Focus on decisions", undefined, undefined, streamFn);
  assert.match(result.summary, /summary/);
  assert.equal(calls.length, 2);
  for (const { context, options } of calls) {
    assert.match(JSON.stringify(context), /Focus on decisions/);
    assert.equal(options?.maxTokens, undefined);
    assert.ok(options?.sessionId);
    assert.equal(options?.cacheRetention, "none");
  }
  assert.notEqual(calls[0]!.options?.sessionId, calls[1]!.options?.sessionId);
});

test("Pi rejects incomplete or tool-calling summaries", async (t) => {
  const toolResponse = response("toolUse");
  toolResponse.content = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } }];
  for (const row of [
    { name: "length", message: response("length"), error: /token cap.*incomplete/ },
    { name: "tool call", message: toolResponse, error: /attempted to call a tool/ },
  ]) {
    await t.test(row.name, async () => {
      await assert.rejects(compact(preparation(), model, undefined, undefined, undefined, undefined, undefined, mockStream(row.message)), row.error);
    });
  }
});
