import assert from "node:assert/strict";
import test from "node:test";
import { formatAcpToolWarning } from "./tool-warning.ts";

const prefix = "Antigravity ACP: unverified tool activity — ";
const circular: Record<string, unknown> = {};
circular.self = circular;
const unchanged = { nested: { secret: "keep original", path: "file" } };
const throwing = { toJSON() { throw new Error("cannot serialize"); } };

const cases: { title: string; name: string; args: unknown; expected: string; verify?: () => void }[] = [
  { title: "exact view_file example", name: "view_file", args: { path: "/tmp/example.ts" },
    expected: 'view_file {"path":"/tmp/example.ts"}' },
  { title: "MCP arguments object", name: "mcp__server__search", args: { query: "hello", limit: 2 },
    expected: 'mcp__server__search {"query":"hello","limit":2}' },
  { title: "nested sensitive keys", name: "mcp", args: { token: "a", nested: [{ password: "b", secret: "c", authorization: "d", cookie: "e", api_key: "f", APIKey: "g", accessToken: "h", path: "ok" }] },
    expected: 'mcp {"token":"[REDACTED]","nested":[{"password":"[REDACTED]","secret":"[REDACTED]","authorization":"[REDACTED]","cookie":"[REDACTED]","api_key":"[REDACTED]","APIKey":"[REDACTED]","accessToken":"[REDACTED]","path":"ok"}]}' },
  { title: "string escapes and terminal controls", name: "\u001b[31mview\u001b[0m\nfile\tname\r!", args: 'quote"\n\t\u001b[31m',
    expected: 'view file name ! "quote\\"\\n\\t\\u001b[31m"' },
  { title: "bounded name and body", name: "n".repeat(121), args: "a".repeat(1100),
    expected: `${"n".repeat(119)}… "${"a".repeat(998)}…` },
  { title: "circular input never throws", name: "tool", args: circular, expected: "tool [unserializable arguments]" },
  { title: "throwing serialization", name: "tool", args: throwing, expected: "tool [unserializable arguments]" },
  { title: "bigint serialization", name: "tool", args: 1n, expected: "tool [unserializable arguments]" },
  { title: "unsupported primitive", name: "tool", args: Symbol("x"), expected: "tool [unserializable arguments]" },
  { title: "original data unchanged", name: "tool", args: unchanged,
    expected: 'tool {"nested":{"secret":"[REDACTED]","path":"file"}}',
    verify: () => assert.deepEqual(unchanged, { nested: { secret: "keep original", path: "file" } }) },
  { title: "undefined becomes empty args", name: "tool", args: undefined, expected: "tool {}" },
  { title: "empty object", name: "tool", args: {}, expected: "tool {}" },
  { title: "null primitive", name: "tool", args: null, expected: "tool null" },
  { title: "number primitive", name: "tool", args: 42, expected: "tool 42" },
  { title: "boolean primitive", name: "tool", args: false, expected: "tool false" },
  { title: "unicode line separators", name: "tool", args: "a\u2028b\u2029c", expected: 'tool "a\\u2028b\\u2029c"' },
];

for (const row of cases) {
  test(`ACP tool warning: ${row.title}`, () => {
    const result = formatAcpToolWarning(row.name, row.args);

    assert.equal(result, prefix + row.expected);
    assert.ok(result.length <= prefix.length + 120 + 1 + 1000);
    row.verify?.();
  });
}
