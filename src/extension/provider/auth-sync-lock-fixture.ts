import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import lockfile from "proper-lockfile";

const authPath = process.argv[2];
if (!authPath) throw new Error("authPath is required");
const release = await lockfile.lock(authPath, { realpath: false, stale: 30_000, retries: 0 });
try {
  process.stdout.write("locked\n");
  for await (const line of createInterface({ input: process.stdin })) {
    writeFileSync(authPath, line);
    break;
  }
} finally {
  await release();
}
