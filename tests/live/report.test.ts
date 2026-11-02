import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sanitize, writeReport, type Result, type Status } from "./report.ts";

const redacted = "[REDACTED]";
const sanitizationCases: { name: string; input: unknown; expected: unknown }[] = [
  { name: "null", input: null, expected: null },
  { name: "undefined", input: undefined, expected: undefined },
  { name: "number", input: 42, expected: 42 },
  { name: "boolean", input: false, expected: false },
  { name: "ordinary text", input: "backend unavailable", expected: "backend unavailable" },
  {
    name: "secret keys at every depth",
    input: { accessToken: "one", AUTHORIZATION: "two", credentials: { private: "three" }, email: "four", accountId: "five", nested: [{ password: "six", api_key: "seven", clientSecret: "eight", safe: "ok" }] },
    expected: { accessToken: redacted, AUTHORIZATION: redacted, credentials: redacted, email: redacted, accountId: redacted, nested: [{ password: redacted, api_key: redacted, clientSecret: redacted, safe: "ok" }] },
  },
  { name: "current home", input: `${homedir()}/project/log`, expected: "[HOME]/project/log" },
  { name: "macOS home", input: "/Users/alice/project", expected: "[HOME]/project" },
  { name: "Linux home", input: "/home/alice/project", expected: "[HOME]/project" },
  { name: "Windows home", input: "C:\\Users\\alice\\project", expected: "[HOME]\\project" },
  { name: "tilde home", input: "~/project", expected: "[HOME]/project" },
  { name: "emails in prose", input: "Contact alice+tag@example.com or bob@example.org.", expected: `Contact ${redacted} or ${redacted}.` },
  { name: "bearer strings", input: "Bearer abc.def and bearer xyz==", expected: `Bearer ${redacted} and Bearer ${redacted}` },
  { name: "URL query", input: "See https://example.com/api?key=secret&other=value", expected: `See https://example.com/api?${redacted}` },
  { name: "token in error text", input: 'access_token=opaque refresh_token="private"', expected: `access_token=${redacted} refresh_token="${redacted}"` },
  { name: "OAuth fragment", input: "https://example.com/callback#access_token=opaque", expected: `https://example.com/callback#${redacted}` },
  { name: "URL without query", input: "https://example.com/api", expected: "https://example.com/api" },
  { name: "URL credentials", input: "https://user:password@example.com/api?key=value", expected: `https://${redacted}@example.com/api?${redacted}` },
  {
    name: "recursive arrays and objects",
    input: [{ output: ["Bearer abc", "alice@example.com", "https://example.com/?q=secret"], count: 1 }],
    expected: [{ output: [`Bearer ${redacted}`, redacted, `https://example.com/?${redacted}`], count: 1 }],
  },
];

for (const { name, input, expected } of sanitizationCases) {
  test(`sanitize: ${name}`, () => {
    const original = structuredClone(input);

    const actual = sanitize(input);

    assert.deepEqual(actual, expected);
    assert.deepEqual(input, original, "sanitization must not mutate its input");
  });
}

const statuses: Status[] = ["PASS", "FAIL", "INCONCLUSIVE", "SKIP"];
const categories: Result["category"][] = ["setup", "backend", "model", "transport", "bridge", "limitation"];
const results: Result[] = categories.map((category, index) => ({
  id: `case-${index}`,
  description: "offline | check\nnext line",
  expected: { value: "safe", token: "expected-secret" },
  observed: { value: "Bearer observed-secret", nested: [{ account: "private-account" }] },
  status: statuses[index % statuses.length]!,
  reason: "Contact person@example.com",
  category,
  deterministic: index % 2 === 0,
  environment: { cwd: "/home/alice/project", auth: "environment-secret", endpoint: "https://example.com/?key=query-secret" },
  evidence: "Bearer evidence-secret",
}));

for (const scenario of ["new directory", "existing public files", "empty results"] as const) {
  test(`writeReport: ${scenario}`, async (t) => {
    const temporary = await mkdtemp(path.join(tmpdir(), "agy-report-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const directory = path.join(temporary, "reports", "run");
    const input = scenario === "empty results" ? [] : structuredClone(results);
    const original = structuredClone(input);
    if (scenario === "existing public files") {
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o755);
      for (const filename of ["results.json", "summary.md"]) {
        await writeFile(path.join(directory, filename), "stale content");
        await chmod(path.join(directory, filename), 0o644);
      }
    }

    await writeReport(directory, input);

    const json = await readFile(path.join(directory, "results.json"), "utf8");
    const markdown = await readFile(path.join(directory, "summary.md"), "utf8");
    assert.deepEqual(JSON.parse(json), sanitize(input));
    assert.deepEqual(input, original);
    for (const status of statuses) {
      const count = input.filter((result) => result.status === status).length;
      assert.ok(markdown.includes(`| ${status} | ${count} |`));
    }
    for (const result of input) {
      assert.ok(markdown.includes(result.id));
      assert.ok(markdown.includes(result.category));
      assert.ok(markdown.includes(`| ${result.status} |`));
    }
    for (const content of [json, markdown]) {
      for (const secret of ["expected-secret", "observed-secret", "private-account", "person@example.com", "/home/alice", "environment-secret", "query-secret", "evidence-secret", "stale content"]) {
        assert.ok(!content.includes(secret), `report must not contain ${secret}`);
      }
    }
    if (input.length > 0) {
      assert.ok(markdown.includes("offline &#124; check<br>next line"));
      assert.ok(markdown.includes(redacted));
    }
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const filename of ["results.json", "summary.md"]) {
      assert.equal((await stat(path.join(directory, filename))).mode & 0o777, 0o600);
    }
  });
}
