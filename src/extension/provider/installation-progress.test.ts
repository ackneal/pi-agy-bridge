import assert from "node:assert/strict";
import test from "node:test";
import type { AcpInstallProgress } from "../drivers/acp/installation.ts";
import { AcpInstallationProgress } from "./installation-progress.ts";

function event(phase: AcpInstallProgress["phase"], message: string = phase): AcpInstallProgress {
  return { phase, message, version: "1.0", platform: "test" };
}

test("ACP installation progress presents lifecycle transitions", () => {
  for (const scenario of [
    { name: "download then completion", phases: ["download", "verify", "complete"] as const },
    { name: "cached validation", phases: ["validate", "complete"] as const },
  ]) {
    const statuses: Array<[string, string | undefined]> = [];
    const notices: string[] = [];
    const stderr: string[] = [];
    const presenter = new AcpInstallationProgress(() => ({
      setStatus: (key, message) => statuses.push([key, message]),
      notify: (message) => notices.push(message),
    }), (line) => stderr.push(line));
    for (const phase of scenario.phases) presenter.update(event(phase));
    assert.deepEqual(notices, [], scenario.name);
    assert.deepEqual(statuses.map(([, message]) => message), [
      ...scenario.phases.slice(0, -1), undefined,
    ], scenario.name);
    assert.deepEqual(stderr, [], "working UI does not also print progress to stderr");
  }
});

test("errors and cancellation clear status; duplicate events are suppressed", () => {
  for (const phase of ["error", "cancelled"] as const) {
    const statuses: Array<string | undefined> = [];
    const notices: Array<{ message: string; type: string | undefined }> = [];
    const presenter = new AcpInstallationProgress(() => ({
      setStatus: (_key, message) => statuses.push(message),
      notify: (message, type) => notices.push({ message, type }),
    }), () => {});
    const progress = event(phase, "failed");
    presenter.update(progress);
    presenter.update(progress);
    assert.equal(statuses.at(-1), undefined);
    assert.deepEqual(notices, phase === "error" ? [{ message: "failed", type: "error" }] : []);
  }
});

test("download stderr output is throttled while phase changes are always written", () => {
  const originalNow = Date.now;
  let now = 10000;
  Date.now = () => now;
  try {
    const lines: string[] = [];
    const presenter = new AcpInstallationProgress(() => undefined, (line) => lines.push(line));
    presenter.update(event("download", "one"));
    presenter.update(event("download", "two"));
    now += 2001;
    presenter.update(event("download", "three"));
    presenter.update(event("verify", "verify"));
    assert.deepEqual(lines, ["one", "three", "verify"]);
  } finally {
    Date.now = originalNow;
  }
});

for (const terminal of ["error", "cancelled", "complete"] as const) {
  test(`progress supports retry after ${terminal} without informational notices`, () => {
    const notices: string[] = [];
    const presenter = new AcpInstallationProgress(() => ({ setStatus() {}, notify: (message) => notices.push(message) }), () => {});
    presenter.update(event("download"));
    presenter.update(event(terminal));
    presenter.update(event("validate"));
    presenter.update(event("complete", "cache ready"));
    assert.ok(!notices.includes("cache ready"));
    presenter.update(event("download"));
    assert.deepEqual(notices, terminal === "error" ? ["error"] : []);
    presenter.clear();
    presenter.update(event("complete", "after clear"));
    assert.ok(!notices.includes("after clear"));
  });
}

for (const brokenUI of [false, true]) {
  test(`headless or broken UI retains actionable errors (${brokenUI})`, () => {
    const lines: string[] = [];
    const presenter = new AcpInstallationProgress(() => brokenUI ? {
      setStatus() { throw new Error("UI unavailable"); }, notify() { throw new Error("UI unavailable"); },
    } : undefined, (line) => lines.push(line));
    presenter.update(event("download", "download progress"));
    presenter.update(event("error", "Cache is not writable: /custom/home/cache"));
    assert.ok(lines.includes("download progress"));
    assert.equal(lines.at(-1), "Cache is not writable: /custom/home/cache");
  });
}
