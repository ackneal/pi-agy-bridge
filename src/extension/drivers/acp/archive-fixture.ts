import { deflateRawSync } from "node:zlib";
import { writeFile } from "node:fs/promises";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

export interface ZipFixtureEntry { name: string; data?: string | Buffer; mode?: number; }
export async function writeZipFixture(file: string, entries: ZipFixtureEntry[]): Promise<void> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), name, compressed]);
    locals.push(local);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(0x0314), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(mode << 16), u32(offset), name]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
  await writeFile(file, Buffer.concat([...locals, central, end]));
}
