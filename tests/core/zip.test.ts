import { describe, expect, it } from "vitest";
import { crc32, createZip, dosDateTime, readZip, ZipError } from "../../src/core/zip";

const text = (value: string) => new TextEncoder().encode(value);

describe("crc32", () => {
  it("matches the standard check values", () => {
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(text("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("dosDateTime", () => {
  it("packs local date and time with two-second resolution", () => {
    expect(dosDateTime(new Date(2026, 10, 10, 13, 45, 59))).toEqual({
      date: ((2026 - 1980) << 9) | (11 << 5) | 10,
      time: (13 << 11) | (45 << 5) | 29,
    });
  });

  it("clamps years outside the DOS range", () => {
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});

describe("createZip", () => {
  it("round-trips stored entries with UTF-8 names", () => {
    const entries = [
      { name: "01-first.png", data: Uint8Array.of(1, 2, 3) },
      { name: "02-café.png", data: text("hello") },
      { name: "03-empty.png", data: new Uint8Array() },
    ];
    const zip = createZip(entries, new Date(2026, 0, 2, 3, 4, 6));
    const listing = readZip(zip);
    expect(listing.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    listing.forEach((entry, index) => {
      expect([...entry.data]).toEqual([...entries[index]!.data]);
      expect(entry.crc).toBe(crc32(entries[index]!.data));
    });
  });

  it("writes the standard signatures and sizes", () => {
    const zip = createZip([{ name: "a.txt", data: text("abc") }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800); // UTF-8 names
    expect(view.getUint16(8, true)).toBe(0); // stored
    expect(view.getUint32(18, true)).toBe(3);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(1);
    expect(zip.length).toBe(30 + 5 + 3 + 46 + 5 + 22);
  });

  it("creates a valid empty archive", () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it("rejects empty file names", () => {
    expect(() => createZip([{ name: "", data: new Uint8Array() }])).toThrow(ZipError);
  });
});

describe("readZip", () => {
  it("rejects data that isn't a ZIP archive", () => {
    expect(() => readZip(new Uint8Array(10))).toThrow(ZipError);
    expect(() => readZip(new Uint8Array(40))).toThrow(ZipError);
  });

  it("rejects a corrupt central directory or local header", () => {
    const zip = createZip([{ name: "a", data: text("x") }]);
    const badCentral = zip.slice();
    badCentral[30 + 1 + 1] = 0; // first byte of the central directory signature
    expect(() => readZip(badCentral)).toThrow(/central directory/);
    const badLocal = zip.slice();
    badLocal[0] = 0;
    expect(() => readZip(badLocal)).toThrow(/local header/);
  });

  it("rejects compressed entries", () => {
    const zip = createZip([{ name: "a", data: text("x") }]);
    new DataView(zip.buffer).setUint16(30 + 1 + 1 + 10, 8, true);
    expect(() => readZip(zip)).toThrow(/stored/);
  });
});
