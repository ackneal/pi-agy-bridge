import assert from "node:assert/strict";
import test from "node:test";
import type { DriverInstallationProgress } from "../drivers/types.ts";
import { AcpInstallationProgress } from "./installation-progress.ts";
import { ProgressStatus } from "./progress.ts";

function event(phase: DriverInstallationProgress["phase"], message: string = phase): DriverInstallationProgress {
  return { phase, message, version: "1.0", platform: "test" };
}

test("download lifecycle shares and restores status while validation stays silent", () => {
  const statuses: Array<[string, string | undefined]> = [];
  const notices: string[] = [];
  const stderr: string[] = [];
  const ui = {
    setStatus: (key: string, message: string | undefined) => statuses.push([key, message]),
    notify: (message: string) => notices.push(message),
  };
  const progress = new ProgressStatus();
  const presenter = new AcpInstallationProgress(() => ui, (message) => stderr.push(message), progress);
  const restoreDoctor = progress.show(ui, "Doctor is working");
  statuses.length = 0;

  presenter.update(event("validate"));
  presenter.update(event("download"));
  presenter.update(event("verify"));
  presenter.update(event("extract"));
  presenter.update(event("validate"));
  presenter.update(event("complete"));

  assert.deepEqual(statuses.map(([, message]) => message), ["download", "verify", "extract", "Doctor is working"]);
  assert.ok(statuses.every(([key]) => key === "agy-bridge"));
  assert.deepEqual(notices, []);
  assert.deepEqual(stderr, []);

  restoreDoctor();
  assert.deepEqual(statuses.at(-1), ["agy-bridge", undefined]);
});

for (const hasUI of [true, false]) {
  test(`repeated routine validation stays silent with UI=${hasUI}`, () => {
    const statuses: Array<string | undefined> = [];
    const notices: string[] = [];
    const stderr: string[] = [];
    const ui = {
      setStatus: (_key: string, message: string | undefined) => statuses.push(message),
      notify: (message: string) => notices.push(message),
    };
    const presenter = new AcpInstallationProgress(() => hasUI ? ui : undefined, (message) => stderr.push(message));

    for (let attempt = 0; attempt < 2; attempt++) {
      presenter.update(event("validate"));
      presenter.update(event("complete"));
    }

    assert.deepEqual(statuses, []);
    assert.deepEqual(notices, []);
    assert.deepEqual(stderr, []);
  });
}

test("headless progress is throttled, reports phase changes, and keeps routine phases silent", () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const stderr: string[] = [];
    const presenter = new AcpInstallationProgress(() => undefined, (message) => stderr.push(message));
    presenter.update(event("validate"));
    presenter.update(event("download", "one"));
    presenter.update(event("download", "two"));
    now += 2_001;
    presenter.update(event("download", "three"));
    presenter.update(event("verify", "verify"));
    presenter.update(event("extract", "extract"));
    presenter.update(event("validate"));
    presenter.update(event("complete"));

    assert.deepEqual(stderr, ["one", "three", "verify", "extract", "complete"]);
  } finally {
    Date.now = originalNow;
  }
});

test("errors notify when possible and fall back to stderr", () => {
  for (const scenario of [
    { ui: true, broken: false, expectedNotices: ["failed"], expectedStderr: [] },
    { ui: false, broken: false, expectedNotices: [], expectedStderr: ["failed"] },
    { ui: true, broken: true, expectedNotices: [], expectedStderr: ["failed"] },
  ]) {
    const notices: string[] = [];
    const stderr: string[] = [];
    const presenter = new AcpInstallationProgress(() => scenario.ui ? {
      notify: (message: string) => {
        if (scenario.broken) throw new Error("UI unavailable");
        notices.push(message);
      },
      setStatus() {},
    } : undefined, (message) => stderr.push(message));

    presenter.update(event("error", "failed"));

    assert.deepEqual(notices, scenario.expectedNotices);
    assert.deepEqual(stderr, scenario.expectedStderr);
  }
});

test("duplicate errors are suppressed and clear permits reporting again", () => {
  const notices: string[] = [];
  const presenter = new AcpInstallationProgress(() => ({ notify: (message: string) => notices.push(message), setStatus() {} }), () => {});
  const failure = event("error", "failed");

  presenter.update(failure);
  presenter.update(failure);
  presenter.clear();
  presenter.update(failure);

  assert.deepEqual(notices, ["failed", "failed"]);
});
