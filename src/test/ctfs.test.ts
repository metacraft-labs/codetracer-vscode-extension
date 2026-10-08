/**
 * Tests for the CTFS container, `meta.dat` and `paths.dat` readers in
 * `src/ctfs.ts`.
 *
 * Normative sources (codetracer-trace-format-spec):
 *   - `ctfs-container.md` §1 (container version 5), §2 ("`MapBlock` has
 *     three forms", "Older versions are refused"), §4 (block resolution and
 *     the null-pointer rules);
 *   - `internal-files.md` §"Metadata (meta.dat)" (version 6, 12-byte header,
 *     no path list) and the `paths.dat` layouts under §"Interning Tables".
 *
 * These tests build containers byte-by-byte rather than mocking the
 * reader's inputs: the thing under test is how a specific byte sequence on
 * disk is interpreted, so anything short of real bytes would be testing the
 * mock. No mock objects are used.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  CtfsContainer,
  SUPPORTED_CTFS_CONTAINER_VERSION,
  SUPPORTED_META_DAT_VERSION,
  parseMetaDat,
  parsePathsDat,
  readCtfsTrace,
} from "../ctfs";

// ── Fixture builders ────────────────────────────────────────────────────

const CTFS_MAGIC = Buffer.from([0xc0, 0xde, 0x72, 0xac, 0xe2]);
const CTFS_DIRECT = 1n << 63n;
const META_DAT_MAGIC = Buffer.from([0x43, 0x54, 0x4d, 0x44]);
const BLOCK_SIZE = 1024;
const MAX_ENTRIES = 8;
const BASE40_CHARS = "\x00" + "0123456789abcdefghijklmnopqrstuvwxyz./-";

const FLAG_HAS_COLUMN_AWARE_STEPS = 1 << 4;
const FLAG_HAS_LINE_COUNT_TABLE = 1 << 14;

function encodeVarint(value: number | bigint): Buffer {
  const out: number[] = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v !== 0n);
  return Buffer.from(out);
}

function zigzag(n: number): bigint {
  const b = BigInt(n);
  return b >= 0n ? b << 1n : ((-b) << 1n) - 1n;
}

function lenString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([encodeVarint(bytes.length), bytes]);
}

function base40Encode(name: string): bigint {
  let value = 0n;
  let mult = 1n;
  for (const ch of name) {
    const idx = BASE40_CHARS.indexOf(ch);
    assert.ok(idx > 0, `character outside CTFS base40 alphabet: ${ch}`);
    value += BigInt(idx) * mult;
    mult *= 40n;
  }
  return value;
}

interface MetaDatFields {
  recordingId: string;
  program: string;
  args: string[];
  workdir: string;
  recorderId: string;
}

/**
 * Serialize a version 6 `meta.dat` payload: the 12-byte header
 * (magic, version, flags, flags_ext) and a body that ends at
 * `recorder_id`. `version` is a parameter so the tests can stamp the
 * containers a current writer never would.
 */
function buildMetaDat(version: number, f: MetaDatFields, flags = 0, flagsExt = 0): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(version, 0);
  header.writeUInt16LE(flags, 2);
  header.writeUInt32LE(flagsExt, 4);
  return Buffer.concat([
    META_DAT_MAGIC,
    header,
    lenString(f.recordingId),
    lenString(f.program),
    encodeVarint(f.args.length),
    ...f.args.map(lenString),
    lenString(f.workdir),
    lenString(f.recorderId),
  ]);
}

/**
 * Wrap internal files in a version 5 CTFS container laid out as a writer
 * that has closed it must lay it out (`ctfs-container.md` §2): an empty
 * member owns no block, a member of at most one block is direct (its
 * `MapBlock` carries the tag), and a larger one has a level-1 mapping
 * block followed by its data blocks.
 */
function buildMinimalCtfs(files: Array<[string, Buffer]>, version = 5): Buffer {
  assert.ok(files.length <= MAX_ENTRIES, "too many internal files");
  const root = Buffer.alloc(BLOCK_SIZE);
  CTFS_MAGIC.copy(root, 0);
  root[5] = version;
  root.writeUInt32LE(BLOCK_SIZE, 8);
  root.writeUInt32LE(MAX_ENTRIES, 12);

  const blocks: Buffer[] = [root];
  const claim = (b: Buffer): number => {
    blocks.push(b);
    return blocks.length - 1;
  };
  const dataBlock = (data: Buffer, from: number): Buffer => {
    const b = Buffer.alloc(BLOCK_SIZE);
    data.copy(b, 0, from, Math.min(data.length, from + BLOCK_SIZE));
    return b;
  };

  files.forEach(([name, data], i) => {
    const off = 16 + i * 24;
    let mapBlock = 0n;
    if (data.length > 0 && data.length <= BLOCK_SIZE) {
      mapBlock = CTFS_DIRECT | BigInt(claim(dataBlock(data, 0)));
    } else if (data.length > BLOCK_SIZE) {
      const nblocks = Math.ceil(data.length / BLOCK_SIZE);
      assert.ok(nblocks < BLOCK_SIZE / 8, "fixture builder handles level-1 mappings only");
      const mapping = Buffer.alloc(BLOCK_SIZE);
      const m = claim(mapping);
      for (let k = 0; k < nblocks; k++) {
        mapping.writeBigUInt64LE(BigInt(claim(dataBlock(data, k * BLOCK_SIZE))), k * 8);
      }
      mapBlock = BigInt(m);
    }
    root.writeBigUInt64LE(BigInt(data.length), off);
    root.writeBigUInt64LE(mapBlock, off + 8);
    root.writeBigUInt64LE(base40Encode(name), off + 16);
  });
  return Buffer.concat(blocks);
}

/** Overwrite one root entry's `(Size, MapBlock)` in a built container. */
function patchEntry(container: Buffer, index: number, size: bigint, mapBlock: bigint): Buffer {
  const copy = Buffer.from(container);
  copy.writeBigUInt64LE(size, 16 + index * 24);
  copy.writeBigUInt64LE(mapBlock, 16 + index * 24 + 8);
  return copy;
}

/** Serialize `paths.dat` + `paths.off` from already-framed records. */
function buildPathsTable(records: Buffer[]): { dat: Buffer; off: Buffer } {
  const off = Buffer.alloc(records.length * 8);
  let pos = 0;
  records.forEach((r, i) => {
    off.writeBigUInt64LE(BigInt(pos), i * 8);
    pos += r.length;
  });
  return { dat: Buffer.concat(records), off };
}

const bareRecord = (p: string): Buffer => Buffer.from(p, "utf8");
const lineCountRecord = (p: string, lineCount: number): Buffer =>
  Buffer.concat([lenString(p), encodeVarint(lineCount)]);
function layoutARecord(p: string, lineLengths: number[]): Buffer {
  const parts = [lenString(p), encodeVarint(lineLengths.length)];
  lineLengths.forEach((len, i) => {
    parts.push(encodeVarint(zigzag(i === 0 ? len : len - lineLengths[i - 1])));
  });
  return Buffer.concat(parts);
}

const FIELDS: MetaDatFields = {
  recordingId: "01949fcc-7d92-7e9c-aaaa-bbbbbbbbbbbb",
  program: "/work/main.rs",
  args: ["--release"],
  workdir: "/work",
  recorderId: "ct-test/1.0",
};
const PATHS = ["/work/main.rs", "/work/lib.rs"];

const tempDirs: string[] = [];
function writeTraceFolder(container: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-vscode-ctfs-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "main.ct"), container);
  return dir;
}

function traceWith(meta: Buffer, records: Buffer[]): Buffer {
  const { dat, off } = buildPathsTable(records);
  return buildMinimalCtfs([
    ["meta.dat", meta],
    ["paths.dat", dat],
    ["paths.off", off],
  ]);
}

suiteTeardown(() => {
  for (const dir of tempDirs) {fs.rmSync(dir, { recursive: true, force: true });}
});

// ── Container (ctfs-container.md §1, §2, §4) ────────────────────────────

suite("CTFS container version 5", () => {
  test("reads exactly container version 5", () => {
    assert.strictEqual(SUPPORTED_CTFS_CONTAINER_VERSION, 5);
  });

  test("a direct member of at most one block is read from its tagged data block", () => {
    const small = Buffer.from("hello, direct member");
    const exact = Buffer.alloc(BLOCK_SIZE, 0x5a);
    const c = CtfsContainer.fromBytes(buildMinimalCtfs([["small.bin", small], ["exact.bin", exact]]));
    assert.ok(c.readFile("small.bin").equals(small));
    assert.ok(c.readFile("exact.bin").equals(exact));
  });

  test("an empty member (MapBlock = 0) is present and empty, not absent", () => {
    const c = CtfsContainer.fromBytes(buildMinimalCtfs([["empty.bin", Buffer.alloc(0)]]));
    assert.strictEqual(c.hasFile("empty.bin"), true, "a null is not an absence");
    assert.strictEqual(c.readFile("empty.bin").length, 0);
    assert.strictEqual(c.hasFile("absent.bin"), false);
    assert.throws(() => c.readFile("absent.bin"), /not found: absent\.bin/);
  });

  test("a member larger than one block is read through its mapping block", () => {
    const big = Buffer.alloc(BLOCK_SIZE * 2 + 300);
    for (let i = 0; i < big.length; i++) {big[i] = (i * 7 + 3) & 0xff;}
    const c = CtfsContainer.fromBytes(buildMinimalCtfs([["a.bin", Buffer.from("x")], ["big.bin", big]]));
    assert.ok(c.readFile("big.bin").equals(big));
  });

  test("a container of version 4 is refused, naming both versions", () => {
    const v4 = buildMinimalCtfs([["meta.dat", buildMetaDat(6, FIELDS)]], 4);
    assert.throws(
      () => CtfsContainer.fromBytes(v4),
      /unsupported CTFS container version 4 \(this reader reads version 5\)/
    );
    for (const version of [2, 3, 6]) {
      assert.throws(
        () => CtfsContainer.fromBytes(buildMinimalCtfs([], version)),
        new RegExp(`unsupported CTFS container version ${version}\\b`)
      );
    }
  });

  test("a tagged MapBlock with Size above BlockSize is refused", () => {
    const base = buildMinimalCtfs([["small.bin", Buffer.from("abc")]]);
    const bad = patchEntry(base, 0, BigInt(BLOCK_SIZE + 1), CTFS_DIRECT | 1n);
    assert.throws(() => CtfsContainer.fromBytes(bad).readFile("small.bin"), /small\.bin.*one block/);
  });

  test("a tagged MapBlock naming block 0 is refused as a null pointer", () => {
    const base = buildMinimalCtfs([["small.bin", Buffer.from("abc")]]);
    const bad = patchEntry(base, 0, 3n, CTFS_DIRECT);
    assert.throws(() => CtfsContainer.fromBytes(bad).readFile("small.bin"), /small\.bin.*null/);
  });

  test("a tagged MapBlock past the end of the container is refused", () => {
    const base = buildMinimalCtfs([["small.bin", Buffer.from("abc")]]);
    const bad = patchEntry(base, 0, 3n, CTFS_DIRECT | 1000n);
    assert.throws(() => CtfsContainer.fromBytes(bad).readFile("small.bin"), /small\.bin.*past (the )?end/);
  });

  for (const retired of ["events.log", "events.fmt"]) {
    test(`a container carrying ${retired} is refused by name, whatever its size`, () => {
      for (const data of [Buffer.alloc(0), Buffer.from([1, 2, 3])]) {
        const container = buildMinimalCtfs([["meta.dat", buildMetaDat(6, FIELDS)], [retired, data]]);
        assert.throws(
          () => CtfsContainer.fromBytes(container),
          (err: Error) => err.message.includes(`\`${retired}\``) && /not part of the trace format/.test(err.message)
        );
      }
    });
  }

  test("MapBlock = 0 with a non-zero Size is refused as a null pointer, not read as empty", () => {
    const base = buildMinimalCtfs([["small.bin", Buffer.from("abc")]]);
    const bad = patchEntry(base, 0, 3n, 0n);
    const c = CtfsContainer.fromBytes(bad);
    assert.strictEqual(c.hasFile("small.bin"), true);
    assert.throws(() => c.readFile("small.bin"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /small\.bin.*null/);
      assert.ok(!/truncat/i.test(err.message), "a null is not a truncation");
      return true;
    });
  });
});

// ── meta.dat (internal-files.md §"Metadata (meta.dat)") ─────────────────

suite("CTFS meta.dat version 6", () => {
  test("reads exactly meta.dat version 6", () => {
    assert.strictEqual(SUPPORTED_META_DAT_VERSION, 6);
  });

  test("a v6 meta.dat parses to the recorded fields and its flag words", () => {
    const parsed = parseMetaDat(buildMetaDat(6, FIELDS, FLAG_HAS_LINE_COUNT_TABLE, 1));
    assert.strictEqual(parsed.program, FIELDS.program);
    assert.strictEqual(parsed.workdir, FIELDS.workdir);
    assert.strictEqual(parsed.flags, FLAG_HAS_LINE_COUNT_TABLE);
    assert.strictEqual(parsed.flagsExt, 1);
    assert.ok(!("paths" in parsed), "meta.dat carries no path list at version 6");
  });

  test("a v5 meta.dat is refused, naming both versions", () => {
    assert.throws(
      () => parseMetaDat(buildMetaDat(5, FIELDS)),
      /unsupported meta\.dat version 5 \(this reader reads version 6\)/
    );
  });

  test("every other version is refused by name", () => {
    for (const version of [0, 1, 2, 3, 4, 7]) {
      assert.throws(
        () => parseMetaDat(buildMetaDat(version, FIELDS)),
        new RegExp(`unsupported meta\\.dat version ${version}\\b`),
        `v${version} must be refused`
      );
    }
  });

  test("text that is not UTF-8 is refused, naming the field", () => {
    const placeholder = "\u0001\u0002";
    const invalid = Buffer.from([0xc3, 0x28]);
    const withInvalid = (f: MetaDatFields): Buffer => {
      const meta = buildMetaDat(6, f);
      const at = meta.indexOf(Buffer.from(placeholder, "utf8"));
      assert.ok(at >= 0);
      invalid.copy(meta, at);
      return meta;
    };
    assert.throws(() => parseMetaDat(withInvalid({ ...FIELDS, program: `/work/${placeholder}` })), /meta\.dat: program is not UTF-8/);
    assert.throws(() => parseMetaDat(withInvalid({ ...FIELDS, args: ["--release", placeholder] })), /meta\.dat: args is not UTF-8/);
    assert.throws(() => parseMetaDat(withInvalid({ ...FIELDS, workdir: placeholder })), /meta\.dat: workdir is not UTF-8/);
  });

  test("a header shorter than 12 bytes is refused", () => {
    const full = buildMetaDat(6, FIELDS);
    assert.throws(() => parseMetaDat(full.subarray(0, 11)), /shorter than (its )?12-byte header/);
  });

  test("an unknown flags_ext bit is refused, naming the bits", () => {
    assert.throws(() => parseMetaDat(buildMetaDat(6, FIELDS, 0, 0b110)), /flags_ext.*0x6/);
  });

  test("bits 4 and 14 together are refused", () => {
    assert.throws(
      () => parseMetaDat(buildMetaDat(6, FIELDS, FLAG_HAS_COLUMN_AWARE_STEPS | FLAG_HAS_LINE_COUNT_TABLE)),
      /bits 4 and 14/
    );
  });
});

// ── paths.dat (internal-files.md §"Interning Tables") ───────────────────

suite("CTFS paths.dat", () => {
  test("bare records are the path bytes", () => {
    const { dat, off } = buildPathsTable(PATHS.map(bareRecord));
    assert.deepStrictEqual(parsePathsDat(dat, off, 0), PATHS);
  });

  test("line-count records (bit 14) carry a line count after the path", () => {
    const { dat, off } = buildPathsTable([lineCountRecord(PATHS[0], 42), lineCountRecord(PATHS[1], 100000)]);
    assert.deepStrictEqual(parsePathsDat(dat, off, FLAG_HAS_LINE_COUNT_TABLE), PATHS);
  });

  test("a line-count record with line_count 0 is refused", () => {
    const { dat, off } = buildPathsTable([lineCountRecord(PATHS[0], 0)]);
    assert.throws(() => parsePathsDat(dat, off, FLAG_HAS_LINE_COUNT_TABLE), /record 0.*line_count 0/);
  });

  test("Layout A records (bit 4) carry a per-line length table after the path", () => {
    const { dat, off } = buildPathsTable([layoutARecord(PATHS[0], [10, 4, 300, 1]), layoutARecord(PATHS[1], [])]);
    assert.deepStrictEqual(parsePathsDat(dat, off, FLAG_HAS_COLUMN_AWARE_STEPS), PATHS);
  });

  test("a Layout A record with line_count 0 is the conventional table and reads as its path", () => {
    // `path_len, path, 0`: the only encoding of the 100000 x 1024 table
    // (internal-files.md §"`paths.dat` Layout A"), a one-byte table body.
    const rec = layoutARecord(PATHS[0], []);
    assert.strictEqual(rec[rec.length - 1], 0);
    assert.strictEqual(rec.length, 1 + Buffer.byteLength(PATHS[0]) + 1);
    const { dat, off } = buildPathsTable([rec, layoutARecord(PATHS[1], [3])]);
    assert.deepStrictEqual(parsePathsDat(dat, off, FLAG_HAS_COLUMN_AWARE_STEPS), PATHS);
  });

  test("a Layout A record with bytes left over is refused, not read by its prefix", () => {
    const rec = Buffer.concat([layoutARecord(PATHS[0], [10, 20]), Buffer.from([0x05])]);
    const { dat, off } = buildPathsTable([rec]);
    assert.throws(() => parsePathsDat(dat, off, FLAG_HAS_COLUMN_AWARE_STEPS), /record 0.*left over/);
  });

  test("a bare record is not decoded as a framed one when no layout bit is set", () => {
    // The first byte of this bare record equals its remaining length, so it
    // would "decode" under a framed layout; the flags decide, not the bytes.
    const tricky = "\x04/a/b";
    const { dat, off } = buildPathsTable([bareRecord(tricky)]);
    assert.deepStrictEqual(parsePathsDat(dat, off, 0), [tricky]);
  });

  test("a path is the bytes recorded for it, UTF-8 or not, in every layout", () => {
    const raw = Buffer.from([0x2f, 0x77, 0xff, 0x2e, 0x63]);
    const framed = Buffer.concat([encodeVarint(raw.length), raw]);
    const records: Array<[Buffer, number]> = [
      [raw, 0],
      [Buffer.concat([framed, encodeVarint(3)]), FLAG_HAS_LINE_COUNT_TABLE],
      [Buffer.concat([framed, encodeVarint(1), encodeVarint(zigzag(4))]), FLAG_HAS_COLUMN_AWARE_STEPS],
    ];
    for (const [record, flags] of records) {
      const { dat, off } = buildPathsTable([record]);
      assert.deepStrictEqual(parsePathsDat(dat, off, flags), [raw.toString("utf8")]);
    }
  });

  test("offsets that run backwards or past the data are refused", () => {
    const { dat } = buildPathsTable(PATHS.map(bareRecord));
    const off = Buffer.alloc(16);
    off.writeBigUInt64LE(5n, 0);
    off.writeBigUInt64LE(2n, 8);
    assert.throws(() => parsePathsDat(dat, off, 0), /paths\.off/);
    off.writeBigUInt64LE(BigInt(dat.length + 1), 8);
    assert.throws(() => parsePathsDat(dat, off, 0), /paths\.off/);
  });
});

// ── End to end (readCtfsTrace) ──────────────────────────────────────────

suite("readCtfsTrace", () => {
  test("source paths come from paths.dat, including a mapped multi-block paths.dat", () => {
    const many: string[] = [];
    for (let i = 0; i < 120; i++) {many.push(`/work/src/module_${i}.rs`);}
    const records = many.map((p) => lineCountRecord(p, 100 + i32(p)));
    const container = traceWith(buildMetaDat(6, FIELDS, FLAG_HAS_LINE_COUNT_TABLE), records);
    assert.ok(buildPathsTable(records).dat.length > BLOCK_SIZE, "paths.dat must outgrow one block");

    const rejections: string[] = [];
    const trace = readCtfsTrace(writeTraceFolder(container), (m) => rejections.push(m));
    assert.deepStrictEqual(rejections, []);
    assert.ok(trace);
    assert.strictEqual(trace.meta.program, FIELDS.program);
    assert.deepStrictEqual(trace.paths, many);
  });

  test("a trace with an empty paths.dat, or none, has no source paths", () => {
    const empty = buildMinimalCtfs([
      ["meta.dat", buildMetaDat(6, FIELDS)],
      ["paths.dat", Buffer.alloc(0)],
      ["paths.off", Buffer.alloc(0)],
    ]);
    assert.deepStrictEqual(readCtfsTrace(writeTraceFolder(empty), assert.fail)?.paths, []);
    const none = buildMinimalCtfs([["meta.dat", buildMetaDat(6, FIELDS)]]);
    assert.deepStrictEqual(readCtfsTrace(writeTraceFolder(none), assert.fail)?.paths, []);
  });

  test("a version 4 container is reported and yields nothing", () => {
    const { dat, off } = buildPathsTable(PATHS.map(bareRecord));
    const v4 = buildMinimalCtfs(
      [["meta.dat", buildMetaDat(6, FIELDS)], ["paths.dat", dat], ["paths.off", off]],
      4
    );
    const dir = writeTraceFolder(v4);
    const rejections: string[] = [];
    assert.strictEqual(readCtfsTrace(dir, (m) => rejections.push(m)), undefined);
    assert.strictEqual(rejections.length, 1, "the refusal must be reported, not swallowed");
    assert.match(rejections[0], /unsupported CTFS container version 4\b/);
    assert.ok(rejections[0].includes(dir), "the report must name the container it refused");
  });

  test("a container carrying events.log is reported and yields nothing", () => {
    const { dat, off } = buildPathsTable(PATHS.map(bareRecord));
    const legacy = buildMinimalCtfs([
      ["meta.dat", buildMetaDat(6, FIELDS)],
      ["paths.dat", dat],
      ["paths.off", off],
      ["events.log", Buffer.from([0xa0])],
    ]);
    const rejections: string[] = [];
    assert.strictEqual(readCtfsTrace(writeTraceFolder(legacy), (m) => rejections.push(m)), undefined);
    assert.strictEqual(rejections.length, 1);
    assert.match(rejections[0], /`events\.log`/);
  });

  test("a version 5 meta.dat is reported and yields nothing", () => {
    const dir = writeTraceFolder(traceWith(buildMetaDat(5, FIELDS), PATHS.map(bareRecord)));
    const rejections: string[] = [];
    assert.strictEqual(readCtfsTrace(dir, (m) => rejections.push(m)), undefined);
    assert.strictEqual(rejections.length, 1);
    assert.match(rejections[0], /unsupported meta\.dat version 5\b/);
  });
});

/** A small deterministic per-path number, so line counts differ by record. */
function i32(s: string): number {
  let h = 0;
  for (const ch of s) {h = (h * 31 + ch.charCodeAt(0)) % 1000;}
  return h;
}
