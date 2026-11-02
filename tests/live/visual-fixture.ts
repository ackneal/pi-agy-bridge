import { createHash, randomBytes, randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

const digits = [
  ["11111", "10001", "10001", "10001", "10001", "10001", "11111"],
  ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
  ["11111", "00001", "00001", "11111", "00001", "00001", "11111"],
  ["10001", "10001", "10001", "11111", "00001", "00001", "00001"],
  ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
  ["11111", "10000", "10000", "11111", "10001", "10001", "11111"],
  ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  ["11111", "10001", "10001", "11111", "10001", "10001", "11111"],
  ["11111", "10001", "10001", "11111", "00001", "00001", "11111"],
];

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(name, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

export function imageEvidence(bytes: Buffer): { sha256: string; bytes: number } {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/** The white marker panel stays legible; random pixels below it create real image payload size. */
export function createVisualFixture(options: { large?: boolean; bytes?: number; marker?: string } = {}) {
  const marker = options.marker ?? Array.from({ length: 6 }, () => randomInt(10)).join("");
  if (!/^\d{6}$/.test(marker)) throw new Error("Visual marker must contain six digits");
  if (options.bytes !== undefined && (!Number.isSafeInteger(options.bytes) || options.bytes < 4096 || options.bytes >= 8 * 1024 * 1024)) {
    throw new Error("Requested PNG bytes must be an integer between 4096 and 8MiB exclusive");
  }
  const scale = options.large || (options.bytes ?? 0) >= 1024 * 1024 ? 64 : (options.bytes ?? 0) >= 256 * 1024 ? 32 : 8;
  const width = 39 * scale;
  const panelHeight = 11 * scale;
  const noiseBytes = options.bytes === undefined ? 0 : Math.floor(options.bytes * 0.94);
  const height = panelHeight + Math.ceil(noiseBytes / (width * 3));
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  const noise = randomBytes(noiseBytes);
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0;
    if (y >= panelHeight) {
      const start = (y - panelHeight) * width * 3;
      noise.copy(pixels, y * (width * 3 + 1) + 1, start, Math.min(start + width * 3, noiseBytes));
    }
  }
  for (let index = 0; index < marker.length; index++) {
    const glyph = digits[Number(marker[index])]!;
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 5; column++) {
        if (glyph[row]![column] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          const y = (row + 2) * scale + dy;
          const x = (index * 6 + column + 2) * scale;
          pixels.fill(0, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 1 + (x + scale) * 3);
        }
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels))];
  const end = chunk("IEND", Buffer.alloc(0));
  const minimum = parts.reduce((sum, part) => sum + part.length, end.length);
  if (options.bytes !== undefined) {
    if (!Number.isSafeInteger(options.bytes) || options.bytes < minimum + 12 || options.bytes >= 8 * 1024 * 1024) {
      throw new Error(`Requested PNG bytes must be between ${minimum + 12} and 8MiB exclusive`);
    }
    parts.push(chunk("npAd", randomBytes(options.bytes - minimum - 12)));
  }
  const png = Buffer.concat([...parts, end]);
  return { png, data: png.toString("base64"), marker, width, height, ...imageEvidence(png) };
}
