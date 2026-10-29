import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractAcpArchive } from "./archive.ts";
import { writeZipFixture, type ZipFixtureEntry } from "./archive-fixture.ts";

const rejected: { name: string; entries: ZipFixtureEntry[]; error: RegExp }[] = [
  { name: "traversal", entries: [{ name: "../escape" }], error: /invalid relative path|Unsafe archive path/ },
  { name: "absolute path", entries: [{ name: "/escape" }], error: /absolute path|Unsafe archive path/ },
  { name: "Windows drive", entries: [{ name: "C:/escape" }], error: /absolute path|Unsafe archive path/ },
  { name: "backslash", entries: [{ name: "a\\b" }], error: /invalid characters in fileName|Unsafe archive path/ },
  { name: "empty component", entries: [{ name: "a//" }], error: /Unsafe archive path/ },
  { name: "dot component", entries: [{ name: "a/./b" }], error: /Unsafe archive path/ },
  { name: "duplicate file", entries: [{ name: "a", data: "x" }, { name: "a", data: "y" }], error: /Duplicate archive entry/ },
  { name: "file-directory conflict", entries: [{ name: "a" }, { name: "a/" }], error: /Duplicate archive entry/ },
  { name: "file as parent", entries: [{ name: "a" }, { name: "a/b" }], error: /Conflicting archive entry/ },
  { name: "symlink", entries: [{ name: "link", data: "target", mode: 0o120777 }], error: /Unsupported archive entry type/ },
  { name: "escaping symlink", entries: [{ name: "link", data: "../outside", mode: 0o120777 }], error: /Unsupported archive entry type/ },
  { name: "special file", entries: [{ name: "pipe", mode: 0o010644 }], error: /Unsupported archive entry type/ },
];
for (const row of rejected) {
  test(`ZIP extraction rejects ${row.name}`, async (t) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "acp-zip-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const archive = path.join(temp, "test.zip");
    await writeZipFixture(archive, row.entries);
    await assert.rejects(extractAcpArchive(archive, path.join(temp, "out")), row.error);
  });
}

test("ZIP extraction preserves full layout and Unix modes without special permission bits", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "acp-zip-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const archive = path.join(temp, "test.zip");
  const destination = path.join(temp, "out");
  await writeZipFixture(archive, [
    { name: "app/nested/", mode: 0o040750 },
    { name: "app/", mode: 0o040750 },
    { name: "app/nested/.hidden", data: "ok", mode: 0o100640 },
    { name: "empty/" },
    { name: "executable", data: "not a real executable", mode: 0o107555 },
  ]);
  await extractAcpArchive(archive, destination);
  assert.equal(await readFile(path.join(destination, "app/nested/.hidden"), "utf8"), "ok");
  assert.equal((await stat(path.join(destination, "app/nested/.hidden"))).mode & 0o777, 0o640);
  assert.equal((await stat(path.join(destination, "app"))).mode & 0o777, 0o750);
  assert.equal((await stat(path.join(destination, "app/nested"))).mode & 0o777, 0o750);
  assert.equal((await stat(path.join(destination, "executable"))).mode & 0o7777, 0o555);
  assert.equal((await stat(path.join(destination, "empty"))).isDirectory(), true);
});

for (const during of [false, true]) {
  test(`ZIP extraction cancellation ${during ? "during streaming" : "before starting"}`, async (t) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "acp-zip-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const archive = path.join(temp, "test.zip");
    const destination = path.join(temp, "out");
    const size = during ? 16 * 1024 ** 2 : 16;
    await writeZipFixture(archive, [{ name: "large", data: Buffer.alloc(size) }]);
    const controller = new AbortController();
    const reason = new Error("Stop ZIP extraction");
    if (during) {
      await mkdir(destination);
      const timer = setInterval(() => {
        void stat(path.join(destination, "large")).then((file) => {
          if (file.size > 0) controller.abort(reason);
        }, () => {});
      }, 1);
      t.after(() => clearInterval(timer));
    } else controller.abort(reason);
    await assert.rejects(extractAcpArchive(archive, destination, controller.signal), (error) => error === reason);
    if (during) assert.ok((await stat(path.join(destination, "large"))).size < size);
  });
}
