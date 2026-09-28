import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { AgyProtocolParser } from "../protocol.ts";
import type { AgyEvent } from "../types.ts";

async function* parseNdjsonStream(
  stream: AsyncIterable<string | Buffer>
): AsyncIterable<AgyEvent> {
  const parser = new AgyProtocolParser();
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const events = parser.push(text);
    for (const event of events) {
      yield event;
    }
  }
  const remaining = parser.flush();
  for (const event of remaining) {
    yield event;
  }
}

describe("AgyProtocolParser", () => {
  const lineEndingCases = [
    {
      name: "parses single and multiple NDJSON lines with LF endings",
      input:
        JSON.stringify({ event: "init", conversation_id: "conv-1" }) + "\n" +
        JSON.stringify({ event: "step_update", delta: "Hello" }) + "\n",
      expectedCount: 2,
      check: (events: AgyEvent[]) => {
        assert.equal(events[0]?.event, "init");
        assert.equal(events[0]?.conversation_id, "conv-1");
        assert.equal(events[1]?.event, "step_update");
        assert.equal((events[1] as any)?.delta, "Hello");
      },
    },
    {
      name: "handles CRLF (\\r\\n) and empty lines",
      input:
        "\r\n" +
        JSON.stringify({ event: "init", model: "gemini" }) + "\r\n\r\n" +
        JSON.stringify({ event: "result", status: "success" }) + "\r\n",
      expectedCount: 2,
      check: (events: AgyEvent[]) => {
        assert.equal(events[0]?.event, "init");
        assert.equal(events[1]?.event, "result");
      },
    },
  ];

  it("parses LF and CRLF NDJSON lines, including empty lines", () => {
    for (const tc of lineEndingCases) {
      const parser = new AgyProtocolParser();
      const events = parser.push(tc.input);
      assert.equal(events.length, tc.expectedCount);
      tc.check(events);
    }
  });

  it("handles chunked inputs split across arbitrary byte boundaries", () => {
    const parser = new AgyProtocolParser();
    const fullLine = JSON.stringify({ event: "step_update", text: "chunked test" }) + "\n";

    const part1 = fullLine.slice(0, 15);
    const part2 = fullLine.slice(15);

    const events1 = parser.push(part1);
    assert.equal(events1.length, 0);
    assert.equal(parser.getRemainder(), part1);

    const events2 = parser.push(part2);
    assert.equal(events2.length, 1);
    assert.equal(events2[0]?.event, "step_update");
    assert.equal((events2[0] as any)?.text, "chunked test");
    assert.equal(parser.getRemainder(), "");
  });

  it("is resilient to malformed JSON lines and non-object JSON values", () => {
    const parser = new AgyProtocolParser();
    const chunk =
      "not valid json\n" +
      "12345\n" +
      "\"just a string\"\n" +
      "{ malformed: true }\n" +
      JSON.stringify({ event: "valid_event", key: "value" }) + "\n" +
      "[1, 2, 3]\n";

    const events = parser.push(chunk);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, "valid_event");
    assert.equal((events[0] as any)?.key, "value");
  });

  it("flushes remaining buffer at stream end", () => {
    const parser = new AgyProtocolParser();
    parser.push(JSON.stringify({ event: "final_event", done: true }));
    assert.equal(parser.getRemainder().length > 0, true);

    const flushed = parser.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0]?.event, "final_event");
    assert.equal(parser.getRemainder(), "");
  });

});

describe("parseNdjsonStream async generator", () => {
  it("yields parsed events from an async iterable stream", async () => {
    async function* sourceStream() {
      yield '{"event":"init"}\n{"even';
      yield 't":"step_update","delta":"wor';
      yield 'ld"}\n';
      yield '{"event":"result","status":"success"}';
    }

    const events: AgyEvent[] = [];
    for await (const ev of parseNdjsonStream(sourceStream())) {
      events.push(ev);
    }

    assert.equal(events.length, 3);
    assert.equal(events[0]?.event, "init");
    assert.equal(events[1]?.event, "step_update");
    assert.equal((events[1] as any)?.delta, "world");
    assert.equal(events[2]?.event, "result");
  });
});
