/**
 * Minimal CTFS binary container + `meta.dat` reader.
 *
 * Current CodeTracer recorders emit a single `.ct` CTFS container per
 * trace; the legacy `trace_metadata.json` / `trace_paths.json` sidecars
 * are no longer produced. The source file list a trace references lives
 * inside the container's internal `meta.dat` file (CTMD format).
 *
 * This module implements the read-only subset of the CTFS v2/v3/v4
 * binary container needed to extract `meta.dat`, plus the `meta.dat`
 * (CTMD v3) parser. It is a faithful TypeScript port of the Rust
 * reference readers:
 *   - codetracer/src/db-backend/src/ctfs_trace_reader/ctfs_container.rs
 *   - codetracer/src/db-backend/src/ctfs_trace_reader/meta_dat.rs
 *
 * Specs:
 *   - codetracer-specs/Trace-Files/CTFS-Binary-Format.md
 *   - codetracer-specs/Trace-Files (meta.dat §8)
 */
import * as fs from "fs";
import * as path from "path";

// ── CTFS container constants ────────────────────────────────────────────

/** CTFS magic bytes: "C0DE trACE2" in hex-speak. */
const CTFS_MAGIC = Buffer.from([0xc0, 0xde, 0x72, 0xac, 0xe2]);
const CTFS_VERSION_MIN = 2;
const CTFS_VERSION_MAX = 4;
const HEADER_SIZE = 8;
const EXTENDED_HEADER_SIZE = 8;
const FILE_ENTRY_SIZE = 24;
const MAX_MAPPING_LEVELS = 5;

interface CtfsFileEntry {
  size: number;
  mapBlock: number;
}

/**
 * Read-only reader for a CTFS v2/v3/v4 binary container.
 *
 * Loads the whole file into memory and resolves named internal files by
 * walking the hierarchical block-mapping structure.
 */
class CtfsContainer {
  private readonly data: Buffer;
  private readonly blockSize: number;
  private readonly entriesPerBlock: number;
  private readonly files: Map<string, CtfsFileEntry>;

  private constructor(data: Buffer, blockSize: number, files: Map<string, CtfsFileEntry>) {
    this.data = data;
    this.blockSize = blockSize;
    this.entriesPerBlock = Math.floor(blockSize / 8);
    this.files = files;
  }

  /** Parse a CTFS container from a file on disk. */
  static open(filePath: string): CtfsContainer {
    return CtfsContainer.fromBytes(fs.readFileSync(filePath));
  }

  /** Parse a CTFS container from raw bytes. */
  static fromBytes(data: Buffer): CtfsContainer {
    if (data.length < HEADER_SIZE + EXTENDED_HEADER_SIZE) {
      throw new Error(`CTFS container too small (${data.length} bytes)`);
    }
    if (!data.subarray(0, 5).equals(CTFS_MAGIC)) {
      throw new Error("not a valid CTFS container (bad magic bytes)");
    }
    const version = data[5];
    if (version < CTFS_VERSION_MIN || version > CTFS_VERSION_MAX) {
      throw new Error(`unsupported CTFS version ${version}`);
    }

    const blockSize = data.readUInt32LE(8);
    const maxRootEntries = data.readUInt32LE(12);
    if (blockSize !== 1024 && blockSize !== 2048 && blockSize !== 4096) {
      throw new Error(`invalid CTFS block size: ${blockSize}`);
    }

    const files = new Map<string, CtfsFileEntry>();
    const entryStart = HEADER_SIZE + EXTENDED_HEADER_SIZE;
    for (let i = 0; i < maxRootEntries; i++) {
      const offset = entryStart + i * FILE_ENTRY_SIZE;
      if (offset + FILE_ENTRY_SIZE > data.length) break;
      const size = data.readBigUInt64LE(offset);
      const mapBlock = data.readBigUInt64LE(offset + 8);
      const nameEncoded = data.readBigUInt64LE(offset + 16);
      if (nameEncoded === 0n) continue;
      files.set(base40Decode(nameEncoded), {
        size: Number(size),
        mapBlock: Number(mapBlock),
      });
    }
    return new CtfsContainer(data, blockSize, files);
  }

  /** Whether the container holds an internal file with this name. */
  hasFile(name: string): boolean {
    return this.files.has(name);
  }

  /** Read the full contents of a named internal file. */
  readFile(name: string): Buffer {
    const entry = this.files.get(name);
    if (!entry) throw new Error(`CTFS internal file not found: ${name}`);
    if (entry.size === 0) return Buffer.alloc(0);
    if (entry.mapBlock === 0) {
      throw new Error(`CTFS file '${name}' has size but no map block`);
    }
    const totalBlocks = Math.ceil(entry.size / this.blockSize);
    const out = Buffer.alloc(entry.size);
    let written = 0;
    for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex++) {
      const dataBlock = this.resolveBlock(entry.mapBlock, blockIndex);
      if (dataBlock === 0) {
        throw new Error(`CTFS file '${name}': unallocated block ${blockIndex}`);
      }
      const blockOffset = dataBlock * this.blockSize;
      const toRead = Math.min(entry.size - written, this.blockSize);
      if (blockOffset + toRead > this.data.length) {
        throw new Error(`CTFS file '${name}': block extends past end of container`);
      }
      this.data.copy(out, written, blockOffset, blockOffset + toRead);
      written += toRead;
    }
    return out;
  }

  /** Resolve a logical block index to a physical block number. */
  private resolveBlock(rootMapBlock: number, logicalIndex: number): number {
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
      throw new Error(`CTFS block index ${logicalIndex} exceeds maximum mapping depth`);
    }
    let currentBlock = rootMapBlock;
    for (let l = 1; l < level; l++) {
      const indirect = this.readMappingEntry(currentBlock, this.entriesPerBlock - 1);
      if (indirect === 0) throw new Error("CTFS: null indirect pointer in mapping hierarchy");
      currentBlock = indirect;
    }
    if (level === 1) {
      return this.readMappingEntry(currentBlock, remaining);
    }
    return this.resolveMultilevel(currentBlock, remaining, level - 1);
  }

  private resolveMultilevel(mapBlock: number, index: number, depth: number): number {
    if (depth === 0) return this.readMappingEntry(mapBlock, index);
    const directEntries = this.entriesPerBlock - 1;
    const subCapacity = Math.pow(directEntries, depth);
    const subIndex = Math.floor(index / subCapacity);
    const subRemaining = index % subCapacity;
    if (subIndex >= directEntries) {
      throw new Error(`CTFS mapping sub-index ${subIndex} out of range`);
    }
    const next = this.readMappingEntry(mapBlock, subIndex);
    if (next === 0) throw new Error("CTFS: null pointer in mapping sub-block");
    return this.resolveMultilevel(next, subRemaining, depth - 1);
  }

  private readMappingEntry(blockNum: number, entryIndex: number): number {
    const offset = blockNum * this.blockSize + entryIndex * 8;
    if (offset + 8 > this.data.length) {
      throw new Error(`CTFS mapping entry at block ${blockNum} index ${entryIndex} out of bounds`);
    }
    return Number(this.data.readBigUInt64LE(offset));
  }
}

/** Base40 alphabet used to encode CTFS internal file names; index 0 is null padding. */
const BASE40_CHARS = "\x00" + "0123456789abcdefghijklmnopqrstuvwxyz./-";

/** Decode a base40-packed `u64` (as bigint) into a file name string. */
function base40Decode(encoded: bigint): string {
  if (encoded === 0n) return "";
  const chars: number[] = [];
  let v = encoded;
  for (let i = 0; i < 12; i++) {
    const idx = Number(v % 40n);
    v = v / 40n;
    chars.push(BASE40_CHARS.charCodeAt(idx));
  }
  while (chars.length > 0 && chars[chars.length - 1] === 0) chars.pop();
  return String.fromCharCode(...chars);
}

// ── meta.dat (CTMD v3) parser ───────────────────────────────────────────

/** CTMD magic bytes for `meta.dat`: ASCII "CTMD". */
const META_DAT_MAGIC = Buffer.from([0x43, 0x54, 0x4d, 0x44]);

/** Decoded subset of a CTFS `meta.dat` payload (CTMD v3). */
export interface CtfsMetaDat {
  /** Program path or identifier, exactly as recorded. */
  program: string;
  /** Working directory of the recorded program. */
  workdir: string;
  /** Source file paths referenced by the trace. */
  paths: string[];
}

/** Cursor for sequential decoding of a `meta.dat` buffer. */
interface Cursor {
  pos: number;
}

/** Decode one unsigned LEB128 varint. */
function decodeVarint(buf: Buffer, cur: Cursor): number {
  let result = 0n;
  let shift = 0n;
  while (true) {
    if (cur.pos >= buf.length) throw new Error("meta.dat: varint EOF");
    const byte = buf[cur.pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return Number(result);
    shift += 7n;
    if (shift >= 64n) throw new Error("meta.dat: varint too long");
  }
}

/** Decode one varint-length-prefixed UTF-8 string. */
function readString(buf: Buffer, cur: Cursor): string {
  const len = decodeVarint(buf, cur);
  if (cur.pos + len > buf.length) throw new Error("meta.dat: string extends past EOF");
  const s = buf.toString("utf8", cur.pos, cur.pos + len);
  cur.pos += len;
  return s;
}

/**
 * Parse the leading fields of a binary `meta.dat` (CTMD v3) payload.
 *
 * Only the prefix up to and including the `paths` block is decoded — the
 * optional MCR / replay-launch / layout-snapshot / filter-provenance
 * trailers are irrelevant to source-file discovery and are skipped.
 */
function parseMetaDat(buf: Buffer): CtfsMetaDat {
  if (buf.length < 8) throw new Error("meta.dat: too short");
  if (!buf.subarray(0, 4).equals(META_DAT_MAGIC)) {
    throw new Error("meta.dat: bad magic (expected 'CTMD')");
  }
  const version = buf.readUInt16LE(4);
  if (version !== 3) throw new Error(`meta.dat: unsupported version ${version}`);

  const cur: Cursor = { pos: 8 };
  // v3: recording_id (UUIDv7 string) prepends program.
  readString(buf, cur); // recording_id — not needed here
  const program = readString(buf, cur);
  const argsCount = decodeVarint(buf, cur);
  for (let i = 0; i < argsCount; i++) readString(buf, cur);
  const workdir = readString(buf, cur);
  readString(buf, cur); // recorder_id — not needed here
  const pathsCount = decodeVarint(buf, cur);
  const paths: string[] = [];
  for (let i = 0; i < pathsCount; i++) paths.push(readString(buf, cur));

  return { program, workdir, paths };
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
    if (!entry.toLowerCase().endsWith(".ct")) continue;
    const full = path.join(traceFolder, entry);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.size > 0) return full;
    } catch {
      // ignore unreadable entries
    }
  }
  return undefined;
}

/**
 * Read and parse the `meta.dat` metadata from a trace's `.ct` container.
 *
 * Returns `undefined` if no container is found, the container has no
 * `meta.dat`, or parsing fails — callers fall back to other sources.
 */
export function readCtfsMetaDat(traceFolder: string): CtfsMetaDat | undefined {
  const containerPath = findCtfsContainer(traceFolder);
  if (!containerPath) return undefined;
  try {
    const container = CtfsContainer.open(containerPath);
    if (!container.hasFile("meta.dat")) return undefined;
    return parseMetaDat(container.readFile("meta.dat"));
  } catch {
    return undefined;
  }
}
