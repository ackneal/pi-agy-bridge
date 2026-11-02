import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { waitForRelease } from "./pending-updates.ts";

for (const action of ["release", "abort-held", "abort-before", "reject"] as const) {
  test(`pending tool gate: ${action}`, async () => {
    const controller = new AbortController();
    const reason = new Error(action);
    let release!: () => void;
    let fail!: (error: Error) => void;
    const released = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
    if (action === "abort-before") controller.abort(reason);

    try {
      if (action === "abort-before") {
        assert.throws(() => waitForRelease(released, controller.signal), error => error === reason);
        return;
      }
      let settled = false;
      const waiting = waitForRelease(released, controller.signal);
      void waiting.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      assert.equal(settled, false, "Tool must remain held before release or cancellation");
      if (action === "release") {
        release();
        await waiting;
      } else {
        const rejected = assert.rejects(waiting, error => error === reason);
        if (action === "abort-held") controller.abort(reason);
        else fail(reason);
        await rejected;
      }
      await Promise.resolve();
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      release();
    }
  });
}
