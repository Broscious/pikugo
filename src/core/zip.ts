/**
 * Minimal ZIP writer. Entries are stored without compression: the files we
 * package (PNG) are already compressed, so deflating them again would cost
 * time for almost no gain.
 */

export interface ZipEntry {
  /** Path inside the archive, using forward slashes. */
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** General-purpose flag bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const VERSION = 20;
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

let crcTable: Uint32Array | undefined;

/** CRC-32 (IEEE 802.3), as used by ZIP and PNG. */
export function crc32(data: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time fields (local time, 2-second resolution, 1980–2107). */
export function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

/** Build a ZIP archive containing the given entries. */
export function createZip(entries: readonly ZipEntry[], modified = new Date()): Uint8Array<ArrayBuffer> {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipError(`A ZIP archive can hold at most ${MAX_ENTRIES} files`);
  }
  const encoder = new TextEncoder();
  const stamp = dosDateTime(modified);
  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    if (name.length === 0 || name.length > 0xffff) {
      throw new ZipError(`Invalid file name "${entry.name}"`);
    }
    return { name, data: entry.data, crc: crc32(entry.data) };
  });

  const localSize = prepared.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  if (localSize + centralSize + 22 > MAX_UINT32) {
    throw new ZipError("The archive would be larger than 4 GB");
  }

  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const offsets: number[] = [];

  for (const entry of prepared) {
    offsets.push(offset);
    view.setUint32(offset, LOCAL_HEADER, true);
    view.setUint16(offset + 4, VERSION, true);
    view.setUint16(offset + 6, FLAG_UTF8, true);
    view.setUint16(offset + 8, 0, true); // stored
    view.setUint16(offset + 10, stamp.time, true);
    view.setUint16(offset + 12, stamp.date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.name.length, true);
    view.setUint16(offset + 28, 0, true);
    output.set(entry.name, offset + 30);
    output.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }

  const centralStart = offset;
  prepared.forEach((entry, index) => {
    view.setUint32(offset, CENTRAL_HEADER, true);
    view.setUint16(offset + 4, VERSION, true);
    view.setUint16(offset + 6, VERSION, true);
    view.setUint16(offset + 8, FLAG_UTF8, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, stamp.time, true);
    view.setUint16(offset + 14, stamp.date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    // Extra field, comment, disk number, internal and external attributes are all zero.
    view.setUint32(offset + 42, offsets[index]!, true);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });

  view.setUint32(offset, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  return output;
}

export interface ZipListing {
  name: string;
  crc: number;
  data: Uint8Array;
}

/** Read a stored (uncompressed) ZIP archive via its central directory. */
export function readZip(bytes: Uint8Array): ZipListing[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (end < 0 || view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) {
    throw new ZipError("Not a ZIP archive (or it has a comment)");
  }
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipListing[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_HEADER) {
      throw new ZipError("Corrupt central directory");
    }
    if (view.getUint16(offset + 10, true) !== 0) {
      throw new ZipError("Only stored entries are supported");
    }
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (view.getUint32(local, true) !== LOCAL_HEADER) {
      throw new ZipError(`Corrupt local header for "${name}"`);
    }
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ name, crc, data: bytes.subarray(dataStart, dataStart + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
