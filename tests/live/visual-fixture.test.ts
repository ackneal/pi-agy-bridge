import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { createVisualFixture } from "./visual-fixture.ts";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

for (const row of [
  { name: "small", options: { marker: "012345" }, width: 312, height: 88 },
  { name: "large prompt", options: { marker: "678901", large: true, bytes: 4194304 }, width: 2496, height: 1231 },
  ...[[32768, 312, 121], [262144, 1248, 418], [1048576, 2496, 836], [4194304, 2496, 1231]].map(([bytes, width, height]) => ({
    name: `${bytes} decoded bytes`, options: { marker: "012345", bytes: bytes! }, width: width!, height: height!,
  })),
]) {
  test(`visual PNG: ${row.name}`, () => {
    const fixture = createVisualFixture(row.options);
    const png = Buffer.from(fixture.data, "base64");
    assert.deepEqual(png, fixture.png);
    assert.equal(fixture.sha256, createHash("sha256").update(png).digest("hex"));
    assert.equal(fixture.bytes, png.length);
    if ("bytes" in row.options) assert.equal(png.length, row.options.bytes);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const chunks: { name: string; data: Buffer }[] = [];
    let offset = 8;
    while (offset < png.length) {
      const size = png.readUInt32BE(offset);
      const name = png.toString("ascii", offset + 4, offset + 8);
      assert.ok(offset + size + 12 <= png.length);
      assert.equal(crc32(png.subarray(offset + 4, offset + 8 + size)), png.readUInt32BE(offset + 8 + size), `${name} CRC`);
      chunks.push({ name, data: png.subarray(offset + 8, offset + 8 + size) });
      offset += size + 12;
    }
    assert.equal(offset, png.length);
    assert.deepEqual(chunks.map(chunk => chunk.name), ["IHDR", "IDAT", ...("bytes" in row.options ? ["npAd"] : []), "IEND"]);
    const header = chunks[0]!.data;
    assert.equal(header.readUInt32BE(0), row.width);
    assert.equal(header.readUInt32BE(4), row.height);
    assert.deepEqual([...header.subarray(8)], [8, 2, 0, 0, 0]);
    assert.equal(fixture.width, row.width);
    assert.equal(fixture.height, row.height);
    const imageData = Buffer.concat(chunks.filter(chunk => chunk.name === "IDAT").map(chunk => chunk.data));
    if ("bytes" in row.options) assert.ok(imageData.length > png.length * 0.7, "Large payload must be real encoded pixels, not just padding");
    const pixels = inflateSync(imageData);
    assert.equal(pixels.length, (row.width * 3 + 1) * row.height);
    for (let y = 0; y < row.height; y++) assert.equal(pixels[y * (row.width * 3 + 1)], 0);
    const scale = row.width / 39;
    const pixel = (x: number, y: number) => [...pixels.subarray(y * (row.width * 3 + 1) + 1 + x * 3, y * (row.width * 3 + 1) + 4 + x * 3)];
    assert.deepEqual(pixel(0, 0), [255, 255, 255]);
    assert.deepEqual(pixel(2 * scale, 2 * scale), [0, 0, 0]);
    assert.deepEqual(pixel(3 * scale, 3 * scale), [255, 255, 255]);
    assert.deepEqual(pixel(6 * scale, 8 * scale), [0, 0, 0]);
    assert.deepEqual(pixel(row.width - 1, row.height - 1), [255, 255, 255]);
    assert.equal(png.includes(Buffer.from(row.options.marker)), false, "Marker is pixels, not embedded text");
  });
}

test("visual fixture generates fresh six-digit markers", () => {
  const fixtures = Array.from({ length: 8 }, () => createVisualFixture());
  for (const fixture of fixtures) assert.match(fixture.marker, /^\d{6}$/);
  assert.ok(new Set(fixtures.map(fixture => fixture.marker)).size > 1);
});

for (const row of [
  { name: "invalid marker", options: { marker: "secret" }, error: /six digits/ },
  { name: "too small", options: { bytes: 1 }, error: /Requested PNG bytes/ },
  { name: "fractional", options: { bytes: 32768.5 }, error: /Requested PNG bytes/ },
  { name: "artifact cap", options: { bytes: 8 * 1024 * 1024 }, error: /Requested PNG bytes/ },
]) {
  test(`visual fixture rejects ${row.name}`, () => assert.throws(() => createVisualFixture(row.options), row.error));
}
