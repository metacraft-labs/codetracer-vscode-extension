/**
 * Minimal CTFS binary container + `meta.dat` + `paths.dat` reader.
 *
 * Current CodeTracer recorders emit a single `.ct` CTFS container per
 * trace; the legacy `trace_metadata.json` / `trace_paths.json` sidecars
 * are no longer produced. The program and working directory live in the
 * container's internal `meta.dat` (CTMD); the trace's source paths live in
 * the `paths.dat` + `paths.off` interning table, and only there.
 *
 * This module implements the read-only subset of the CTFS version 5
 * container needed to extract those members, the `meta.dat` version 6
 * header and body, and the three `paths.dat` record layouts.
 *
 * Specs (codetracer-trace-format-spec):
 *   - ctfs-container.md §1, §2 ("`MapBlock` has three forms", "Older
 *     versions are refused"), §4 (block resolution, null pointers)
 *   - internal-files.md §"Metadata (meta.dat)", §"Interning Tables" and
 *     the `paths.dat` layouts under it
 */
import * as fs from "fs";
import * as path from "path";

// ── CTFS container constants ────────────────────────────────────────────

/** CTFS magic bytes: "C0DE trACE2" in hex-speak. */
const CTFS_MAGIC = Buffer.from([0xc0, 0xde, 0x72, 0xac, 0xe2]);

/**
 * The one CTFS *container* version this reader reads — the byte at offset
 * 5 of the `.ct` file.
 *
 * This is a different number from the `meta.dat` schema version (see
 * {@link SUPPORTED_META_DAT_VERSION}); the two move independently.
 * Version 5 gave `FileEntry.MapBlock` three forms (empty, direct-tagged,
 * mapped). A version 4 container happens to decode under version 5's
 * rules, but `ctfs-container.md` §2 ("Older versions are refused")
 * requires refusing it by name so that no writer of the old layout stays
 * alive.
 */
export const SUPPORTED_CTFS_CONTAINER_VERSION = 5;

/** Bit 63 of `FileEntry.MapBlock`: the member's only data block follows. */
const CTFS_DIRECT = 1n << 63n;
const HEADER_SIZE = 16;
const FILE_ENTRY_SIZE = 24;
const MAX_MAPPING_LEVELS = 5;

/**
 * Members that are not part of the trace format. A container whose root
 * directory has an entry for either, whatever its size, is refused by name
 * before any member is read (trace-events.md §"Removed members").
 */
const RETIRED_MEMBERS = ["events.log", "events.fmt"];

interface CtfsFileEntry {
  size: bigint;
  mapBlock: bigint;
}

/**
 * Read-only reader for a CTFS version 5 binary container.
 *
 * Loads the whole file into memory and resolves named internal files by
 * the form of their `MapBlock` (`ctfs-container.md` §2): `0` is an empty
 * member, a value with bit 63 set names the member's only data block, and
 * any other value is the root of a hierarchical block mapping (§4).
 */
export class CtfsContainer {
  private readonly data: Buffer;
  private readonly blockSize: number;
  private readonly blockCount: bigint;
  private readonly entriesPerBlock: number;
  private readonly files: Map<string, CtfsFileEntry>;

  private constructor(data: Buffer, blockSize: number, files: Map<string, CtfsFileEntry>) {
    this.data = data;
    this.blockSize = blockSize;
    this.blockCount = BigInt(Math.ceil(data.length / blockSize));
    this.entriesPerBlock = Math.floor(blockSize / 8);
    this.files = files;
  }

  /** Parse a CTFS container from a file on disk. */
  static open(filePath: string): CtfsContainer {
    return CtfsContainer.fromBytes(fs.readFileSync(filePath));
  }

  /** Parse a CTFS container from raw bytes. */
  static fromBytes(data: Buffer): CtfsContainer {
    if (data.length < HEADER_SIZE) {
      throw new Error(`CTFS container too small (${data.length} bytes)`);
    }
    if (!data.subarray(0, 5).equals(CTFS_MAGIC)) {
      throw new Error("not a valid CTFS container (bad magic bytes)");
    }
    const version = data[5];
    if (version !== SUPPORTED_CTFS_CONTAINER_VERSION) {
      throw new Error(
        `unsupported CTFS container version ${version} ` +
        `(this reader reads version ${SUPPORTED_CTFS_CONTAINER_VERSION}); re-record the trace`
      );
    }

    const blockSize = data.readUInt32LE(8);
    const maxRootEntries = data.readUInt32LE(12);
    if (blockSize !== 1024 && blockSize !== 2048 && blockSize !== 4096) {
      throw new Error(`invalid CTFS block size: ${blockSize}`);
    }
    // `MaxRootEntries = 0` auto-fills block 0 (`ctfs-container.md` §1). The
    // entry array starts right after the header, as every writer places it.
    const entryCount = maxRootEntries === 0
      ? Math.floor((blockSize - HEADER_SIZE) / FILE_ENTRY_SIZE)
      : maxRootEntries;

    const files = new Map<string, CtfsFileEntry>();
    for (let i = 0; i < entryCount; i++) {
      const offset = HEADER_SIZE + i * FILE_ENTRY_SIZE;
      if (offset + FILE_ENTRY_SIZE > data.length) {break;}
      const nameEncoded = data.readBigUInt64LE(offset + 16);
      if (nameEncoded === 0n) {continue;}
      files.set(base40Decode(nameEncoded), {
        size: data.readBigUInt64LE(offset),
        mapBlock: data.readBigUInt64LE(offset + 8),
      });
    }
    for (const name of RETIRED_MEMBERS) {
      if (files.has(name)) {
        throw new Error(
          `this container carries \`${name}\`, which is not part of the trace format; it is refused`
        );
      }
    }
    return new CtfsContainer(data, blockSize, files);
  }

  /**
   * Whether the container holds an internal file with this name. An empty
   * member (`(Size, MapBlock) = (0, 0)`) is present.
   */
  hasFile(name: string): boolean {
    return this.files.has(name);
  }

  /** Read the full contents of a named internal file. */
  readFile(name: string): Buffer {
    const entry = this.files.get(name);
    if (!entry) {throw new Error(`CTFS internal file not found: ${name}`);}
    const { size, mapBlock } = entry;

    if (mapBlock === 0n) {
      if (size === 0n) {return Buffer.alloc(0);}
      throw new Error(
        `CTFS file '${name}': null block pointer (MapBlock 0 with size ${size}); the container is damaged`
      );
    }
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`CTFS file '${name}': size ${size} is too large to read`);
    }
    const length = Number(size);

    if ((mapBlock & CTFS_DIRECT) !== 0n) {
      if (size > BigInt(this.blockSize)) {
        throw new Error(
          `CTFS file '${name}': size ${size} is tagged as a direct member, ` +
          `but one block holds at most ${this.blockSize} bytes`
        );
      }
      const out = Buffer.alloc(length);
      this.copyBlock(name, this.checkBlock(name, mapBlock & ~CTFS_DIRECT, "data block"), out, 0, length);
      return out;
    }

    const totalBlocks = Math.ceil(length / this.blockSize);
    const out = Buffer.alloc(length);
    let written = 0;
    for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex++) {
      const dataBlock = this.resolveBlock(name, mapBlock, blockIndex);
      const toRead = Math.min(length - written, this.blockSize);
      this.copyBlock(name, dataBlock, out, written, toRead);
      written += toRead;
    }
    return out;
  }

  /**
   * Refuse a block number of `0` (the header and root directory, and the
   * "unallocated" sentinel) or one past the container's end, before it is
   * ever multiplied by the block size (`ctfs-container.md` §4).
   */
  private checkBlock(name: string, block: bigint, what: string): number {
    if (block === 0n) {
      throw new Error(`CTFS file '${name}': null ${what} pointer; the container is damaged`);
    }
    if (block >= this.blockCount) {
      throw new Error(
        `CTFS file '${name}': ${what} ${block} is past the end of the container (${this.blockCount} blocks)`
      );
    }
    return Number(block);
  }

  private copyBlock(name: string, block: number, out: Buffer, at: number, length: number): void {
    const start = block * this.blockSize;
    if (start + length > this.data.length) {
      throw new Error(`CTFS file '${name}': block ${block} extends past the end of the container`);
    }
    this.data.copy(out, at, start, start + length);
  }

  /** Resolve a logical block index through a mapping rooted at `rootMapBlock`. */
  private resolveBlock(name: string, rootMapBlock: bigint, logicalIndex: number): number {
    const directEntries = this.entriesPerBlock - 1;
    let remaining = logicalIndex;
    let level = 1;
    let levelCapacity = directEntries;
    while (remaining >= levelCapacity && level < MAX_MAPPING_LEVELS) {
      remaining -= levelCapacity;
      level += 1;
      levelCapacity *= directEntries;
    }
    if (remaining >= levelCapacity) {
      throw new Error(`CTFS file '${name}': block index ${logicalIndex} exceeds maximum mapping depth`);
    }
    let currentBlock = this.checkBlock(name, rootMapBlock, "mapping block");
    for (let l = 1; l < level; l++) {
      currentBlock = this.checkBlock(
        name, this.readMappingEntry(currentBlock, this.entriesPerBlock - 1), "chain"
      );
    }
    for (let depth = level - 1; depth > 0; depth--) {
      const subCapacity = Math.pow(directEntries, depth);
      const subIndex = Math.floor(remaining / subCapacity);
      remaining %= subCapacity;
      currentBlock = this.checkBlock(name, this.readMappingEntry(currentBlock, subIndex), "child mapping block");
    }
    return this.checkBlock(name, this.readMappingEntry(currentBlock, remaining), "data block");
  }

  private readMappingEntry(blockNum: number, entryIndex: number): bigint {
    const offset = blockNum * this.blockSize + entryIndex * 8;
    if (offset + 8 > this.data.length) {
      throw new Error(`CTFS mapping entry at block ${blockNum} index ${entryIndex} out of bounds`);
    }
    return this.data.readBigUInt64LE(offset);
  }
}

/** Base40 alphabet used to encode CTFS internal file names; index 0 is null padding. */
const BASE40_CHARS = "\x00" + "0123456789abcdefghijklmnopqrstuvwxyz./-";

/** Decode a base40-packed `u64` (as bigint) into a file name string. */
function base40Decode(encoded: bigint): string {
  if (encoded === 0n) {return "";}
  const chars: number[] = [];
  let v = encoded;
  for (let i = 0; i < 12; i++) {
    const idx = Number(v % 40n);
    v = v / 40n;
    chars.push(BASE40_CHARS.charCodeAt(idx));
  }
  while (chars.length > 0 && chars[chars.length - 1] === 0) {chars.pop();}
  return String.fromCharCode(...chars);
}

// ── meta.dat (CTMD v6) parser ───────────────────────────────────────────

/** CTMD magic bytes for `meta.dat`: ASCII "CTMD". */
const META_DAT_MAGIC = Buffer.from([0x43, 0x54, 0x4d, 0x44]);

/**
 * The one `meta.dat` schema version this reader reads.
 *
 * Version 6 removed the path list that versions 3 to 5 wrote after
 * `recorder_id`, and always carries the u32 `flags_ext` word, so its
 * header is 12 bytes. The bytes after `recorder_id` mean something
 * different in every earlier version, and versions 3 and below also used
 * a superseded `global_position_index` packing, so every other version is
 * refused by name (internal-files.md §"Version History").
 */
export const SUPPORTED_META_DAT_VERSION = 6;

const META_DAT_HEADER_SIZE = 12;

/** `meta.dat` flag bit 4: `paths.dat` records are in Layout A. */
export const FLAG_HAS_COLUMN_AWARE_STEPS = 1 << 4;
/** `meta.dat` flag bit 14: every `paths.dat` record carries a line count. */
export const FLAG_HAS_LINE_COUNT_TABLE = 1 << 14;
/** The `flags_ext` bits this reader implements: bit 0, `SourceReload`. */
const KNOWN_FLAGS_EXT = 0x1;

/** Decoded subset of a CTFS `meta.dat` payload (CTMD v6). */
export interface CtfsMetaDat {
  /** Program path or identifier, exactly as recorded. */
  program: string;
  /** Working directory of the recorded program. */
  workdir: string;
  /** The u16 `flags` word; bits 4 and 14 select the `paths.dat` layout. */
  flags: number;
  /** The u32 `flags_ext` word. */
  flagsExt: number;
}

/** Cursor for sequential decoding of a buffer. */
interface Cursor {
  pos: number;
}

/** Decode one unsigned LEB128 varint as a bigint. */
function decodeVarintBig(buf: Buffer, cur: Cursor, what: string): bigint {
  let result = 0n;
  let shift = 0n;
  while (true) {
    if (cur.pos >= buf.length) {throw new Error(`${what}: varint EOF`);}
    const byte = buf[cur.pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {return result;}
    shift += 7n;
    if (shift >= 70n) {throw new Error(`${what}: varint too long`);}
  }
}

/** Decode one unsigned LEB128 varint that must fit a safe integer. */
function decodeVarint(buf: Buffer, cur: Cursor, what = "meta.dat"): number {
  const v = decodeVarintBig(buf, cur, what);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {throw new Error(`${what}: varint ${v} out of range`);}
  return Number(v);
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Read one varint-length-prefixed byte string. */
function readBytes(buf: Buffer, cur: Cursor, what: string): Buffer {
  const len = decodeVarint(buf, cur, what);
  if (cur.pos + len > buf.length) {throw new Error(`${what}: string extends past EOF`);}
  const bytes = buf.subarray(cur.pos, cur.pos + len);
  cur.pos += len;
  return bytes;
}

/**
 * Decode one varint-length-prefixed `meta.dat` text field, `field`. Every
 * text field of `meta.dat` is UTF-8, and one that is not is refused rather
 * than read with replacement characters (internal-files.md §"Metadata").
 */
function readString(buf: Buffer, cur: Cursor, field: string, what = "meta.dat"): string {
  const bytes = readBytes(buf, cur, what);
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw new Error(`${what}: ${field} is not UTF-8`);
  }
}

/**
 * Parse a binary `meta.dat` (CTMD v6) payload up to `recorder_id`.
 *
 * The flag-gated blocks that may follow `recorder_id` are irrelevant to
 * source-file discovery and are not decoded. Source paths are not in
 * `meta.dat` at version 6; read them with {@link parsePathsDat}.
 *
 * Throws on any version other than {@link SUPPORTED_META_DAT_VERSION}, on
 * a header shorter than 12 bytes, on an unknown `flags_ext` bit, and on a
 * header that sets both bit 4 and bit 14.
 */
export function parseMetaDat(buf: Buffer): CtfsMetaDat {
  if (buf.length >= 4 && !buf.subarray(0, 4).equals(META_DAT_MAGIC)) {
    throw new Error("meta.dat: bad magic (expected 'CTMD')");
  }
  if (buf.length >= 6) {
    const version = buf.readUInt16LE(4);
    if (version !== SUPPORTED_META_DAT_VERSION) {
      throw new Error(
        `meta.dat: unsupported meta.dat version ${version} ` +
        `(this reader reads version ${SUPPORTED_META_DAT_VERSION}); re-record the trace`
      );
    }
  }
  if (buf.length < META_DAT_HEADER_SIZE) {
    throw new Error(`meta.dat: ${buf.length} bytes is shorter than its 12-byte header`);
  }
  const flags = buf.readUInt16LE(6);
  const flagsExt = buf.readUInt32LE(8);
  const unknownExt = flagsExt & ~KNOWN_FLAGS_EXT;
  if (unknownExt !== 0) {
    throw new Error(`meta.dat: flags_ext carries bits this reader does not implement: 0x${(unknownExt >>> 0).toString(16)}`);
  }
  if ((flags & FLAG_HAS_COLUMN_AWARE_STEPS) !== 0 && (flags & FLAG_HAS_LINE_COUNT_TABLE) !== 0) {
    throw new Error("meta.dat: flag bits 4 and 14 are mutually exclusive, and both are set");
  }

  const cur: Cursor = { pos: META_DAT_HEADER_SIZE };
  readString(buf, cur, "recording_id"); // not needed here, but must be UTF-8
  const program = readString(buf, cur, "program");
  const argsCount = decodeVarint(buf, cur);
  for (let i = 0; i < argsCount; i++) {readString(buf, cur, "args");}
  const workdir = readString(buf, cur, "workdir");
  readString(buf, cur, "recorder_id"); // not needed here, but must be UTF-8

  return { program, workdir, flags, flagsExt };
}

// ── paths.dat ───────────────────────────────────────────────────────────

/**
 * Decode the source-path interning table (`paths.dat` + `paths.off`) into
 * paths in id order.
 *
 * The record layout is decided by the `meta.dat` flags, never by the
 * record bytes (internal-files.md §"`paths.dat` line-count table"):
 *   - neither bit: the record is the bare path bytes;
 *   - bit 14: `path_len`, path, a non-zero `line_count`;
 *   - bit 4 (Layout A): `path_len`, path, `line_count`, and `line_count`
 *     zigzag-delta line lengths. `line_count = 0` with no lengths is the
 *     conventional table (100000 lines of 1024 positions, internal-files.md
 *     §"`paths.dat` Layout A"); only the path is needed here, so it parses
 *     like any other record.
 * A framed record must be consumed whole; leftover bytes are refused.
 * Paths are not deduplicated: equal bytes under two ids are two versions.
 */
export function parsePathsDat(dat: Buffer, off: Buffer, flags: number): string[] {
  if (off.length % 8 !== 0) {
    throw new Error(`paths.off: ${off.length} bytes is not a whole number of u64 offsets`);
  }
  const count = off.length / 8;
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    const o = off.readBigUInt64LE(i * 8);
    const prev = i === 0 ? 0n : BigInt(starts[i - 1]);
    if (o > BigInt(dat.length) || o < prev || (i === 0 && o !== 0n)) {
      throw new Error(`paths.off: offset ${o} of record ${i} is out of order or past paths.dat (${dat.length} bytes)`);
    }
    starts.push(Number(o));
  }

  const columnAware = (flags & FLAG_HAS_COLUMN_AWARE_STEPS) !== 0;
  const lineCountTable = (flags & FLAG_HAS_LINE_COUNT_TABLE) !== 0;
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const record = dat.subarray(starts[i], i + 1 < count ? starts[i + 1] : dat.length);
    if (!columnAware && !lineCountTable) {
      paths.push(record.toString("utf8"));
      continue;
    }
    const what = `paths.dat record ${i}`;
    const cur: Cursor = { pos: 0 };
    const p = readBytes(record, cur, what).toString("utf8");
    const lineCount = decodeVarintBig(record, cur, what);
    if (lineCountTable && lineCount === 0n) {
      throw new Error(`${what}: line_count 0 (a file sized zero is indistinguishable from the next)`);
    }
    if (columnAware) {
      for (let k = 0n; k < lineCount; k++) {decodeVarintBig(record, cur, what);}
    }
    if (cur.pos !== record.length) {
      throw new Error(`${what}: ${record.length - cur.pos} bytes left over after the record`);
    }
    paths.push(p);
  }
  return paths;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Locate the `.ct` CTFS container inside a trace folder.
 *
 * Recorders name the container after the recorded program (e.g.
 * `main.ct`, `ruby.ct`), so any single `.ct` file at the folder root is
 * the trace container. Returns the first non-empty `.ct` file found.
 */
export function findCtfsContainer(traceFolder: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(traceFolder);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".ct")) {continue;}
    const full = path.join(traceFolder, entry);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.size > 0) {return full;}
    } catch {
      // ignore unreadable entries
    }
  }
  return undefined;
}

/** What a trace's `.ct` container says about its program and sources. */
export interface CtfsTrace {
  meta: CtfsMetaDat;
  /** Source paths from `paths.dat`, in id order; empty when there are none. */
  paths: string[];
}

/**
 * Read `meta.dat` and the `paths.dat` source-path table from a trace's
 * `.ct` container.
 *
 * Returns `undefined` if no container is found, the container has no
 * `meta.dat`, or reading fails — callers fall back to other sources.
 *
 * A rejection is reported through `onReject` rather than dropped. "No
 * container here" and "this container is one we refuse to read" are
 * different facts that would otherwise both arrive as a bare
 * `undefined`, and a rejected container is the one the operator needs
 * told about: it is on disk, it is the trace they asked for, and the
 * fallback path they end up on will silently find nothing.
 *
 * `onReject` is a parameter rather than a direct `console.warn` call
 * because the VS Code extension host installs a `console` whose methods
 * cannot be replaced, so a test has no other way to observe that a
 * refusal was reported at all.
 */
export function readCtfsTrace(
  traceFolder: string,
  onReject: (message: string) => void = (message) => console.warn(message)
): CtfsTrace | undefined {
  const containerPath = findCtfsContainer(traceFolder);
  if (!containerPath) {return undefined;}
  try {
    const container = CtfsContainer.open(containerPath);
    if (!container.hasFile("meta.dat")) {return undefined;}
    const meta = parseMetaDat(container.readFile("meta.dat"));
    let paths: string[] = [];
    if (container.hasFile("paths.dat")) {
      const dat = container.readFile("paths.dat");
      if (!container.hasFile("paths.off")) {
        if (dat.length !== 0) {throw new Error("paths.dat has no paths.off");}
      } else {
        paths = parsePathsDat(dat, container.readFile("paths.off"), meta.flags);
      }
    }
    return { meta, paths };
  } catch (err) {
    onReject(
      `CodeTracer: ignoring CTFS container ${containerPath}: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}
