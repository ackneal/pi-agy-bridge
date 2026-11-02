import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { imageData } from "./image-fixture.ts";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("live image fixture is a valid one-pixel red PNG", () => {
  const png = Buffer.from(imageData, "base64");
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = new Map<string, Buffer>();
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const name = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + size)), png.readUInt32BE(offset + 8 + size), `${name} CRC`);
    chunks.set(name, data);
    offset += size + 12;
    assert.ok(offset <= png.length);
  }
  assert.deepEqual([...chunks.keys()], ["IHDR", "IDAT", "IEND"]);
  assert.equal(chunks.get("IHDR")!.readUInt32BE(0), 1);
  assert.equal(chunks.get("IHDR")!.readUInt32BE(4), 1);
  assert.deepEqual(inflateSync(chunks.get("IDAT")!), Buffer.from([0, 255, 0, 0]));
});
