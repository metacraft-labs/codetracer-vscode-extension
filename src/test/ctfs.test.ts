/**
 * Version-gate tests for the CTFS `meta.dat` reader in `src/ctfs.ts`.
 *
 * The `meta.dat` schema version went from 3 to 4 when the line-only
 * `global_position_index` encode was corrected from
 * `prefix_sums[file_id] + line` to `prefix_sums[file_id] + (line - 1)`,
 * the inverse of the `line = q + 1` decode every reader performs. No
 * field of the `meta.dat` header changed, so the version is the ONLY
 * thing in a container that distinguishes the two encodes — which is
 * exactly why the gate has to refuse v3 rather than wave it through.
 *
 * These tests build containers byte-by-byte rather than mocking the
 * reader's inputs: the thing under test is how a specific byte sequence
 * on disk is interpreted, so anything short of real bytes would be
 * testing the mock.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  LAST_SHIFTED_GLOBAL_INDEX_VERSION,
  SUPPORTED_META_DAT_VERSIONS,
  parseMetaDat,
  readCtfsMetaDat,
} from "../ctfs";

// ── Fixture builders ────────────────────────────────────────────────────

const CTFS_MAGIC = Buffer.from([0xc0, 0xde, 0x72, 0xac, 0xe2]);
const CTFS_CONTAINER_VERSION = 3;
const META_DAT_MAGIC = Buffer.from([0x43, 0x54, 0x4d, 0x44]);
const BLOCK_SIZE = 1024;
const MAX_ENTRIES = 8;
const BASE40_CHARS = "\x00" + "0123456789abcdefghijklmnopqrstuvwxyz./-";

function encodeVarint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v !== 0);
  return Buffer.from(out);
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
  paths: string[];
}

/**
 * Serialize a `meta.dat` payload stamped with an explicit schema
 * version. The version is a parameter precisely because the tests need
 * to produce the containers a current writer never would.
 */
function buildMetaDat(version: number, f: MetaDatFields): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(version, 0);
  header.writeUInt16LE(0, 2); // flags — no optional blocks
  return Buffer.concat([
    META_DAT_MAGIC,
    header,
    lenString(f.recordingId),
    lenString(f.program),
    encodeVarint(f.args.length),
    ...f.args.map(lenString),
    lenString(f.workdir),
    lenString(f.recorderId),
    encodeVarint(f.paths.length),
    ...f.paths.map(lenString),
  ]);
}

/** Wrap internal files in a minimal one-mapping-block CTFS container. */
function buildMinimalCtfs(files: Array<[string, Buffer]>): Buffer {
  assert.ok(files.length <= MAX_ENTRIES, "too many internal files");
  const root = Buffer.alloc(BLOCK_SIZE);
  CTFS_MAGIC.copy(root, 0);
  root[5] = CTFS_CONTAINER_VERSION;
  root.writeUInt32LE(BLOCK_SIZE, 8);
  root.writeUInt32LE(MAX_ENTRIES, 12);

  files.forEach(([name, data], i) => {
    const off = 16 + i * 24;
    root.writeBigUInt64LE(BigInt(data.length), off);
    root.writeBigUInt64LE(BigInt(1 + i * 2), off + 8); // mapping block
    root.writeBigUInt64LE(base40Encode(name), off + 16);
  });

  const blocks: Buffer[] = [root];
  files.forEach(([, data], i) => {
    const dataBlockNum = 2 + i * 2;
    const mapping = Buffer.alloc(BLOCK_SIZE);
    mapping.writeBigUInt64LE(BigInt(dataBlockNum), 0);
    blocks.push(mapping);

    const padded = Buffer.alloc(Math.max(BLOCK_SIZE, Math.ceil(data.length / BLOCK_SIZE) * BLOCK_SIZE));
    data.copy(padded, 0);
    blocks.push(padded);
  });
  return Buffer.concat(blocks);
}

const FIELDS: MetaDatFields = {
  recordingId: "01949fcc-7d92-7e9c-aaaa-bbbbbbbbbbbb",
  program: "/work/main.rs",
  args: ["--release"],
  workdir: "/work",
  recorderId: "ct-test/1.0",
  paths: ["/work/main.rs", "/work/lib.rs"],
};

function writeTraceFolder(container: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-vscode-ctfs-"));
  fs.writeFileSync(path.join(dir, "main.ct"), container);
  return dir;
}

// ── Tests ───────────────────────────────────────────────────────────────

suite("CTFS meta.dat version gate", () => {
  test("accepts exactly one version, and it is 4", () => {
    assert.deepStrictEqual(
      [...SUPPORTED_META_DAT_VERSIONS],
      [4],
      "accepting more than v4 means accepting the superseded " +
      "global_position_index packing, which reads one line high"
    );
    assert.ok(
      !SUPPORTED_META_DAT_VERSIONS.includes(LAST_SHIFTED_GLOBAL_INDEX_VERSION),
      "the last shifted-encode version must never be in the accepted set"
    );
  });

  test("a v4 meta.dat parses to the recorded fields", () => {
    const parsed = parseMetaDat(buildMetaDat(4, FIELDS));
    assert.strictEqual(parsed.program, FIELDS.program);
    assert.strictEqual(parsed.workdir, FIELDS.workdir);
    assert.deepStrictEqual(parsed.paths, FIELDS.paths);
  });

  test("a v3 meta.dat is refused, naming the superseded encode", () => {
    // Byte-identical to the v4 payload above except for the version
    // stamp — which is the whole point: nothing else in the container
    // could have told the two encodes apart.
    const v3 = buildMetaDat(3, FIELDS);
    const v4 = buildMetaDat(4, FIELDS);
    assert.strictEqual(v3.length, v4.length);
    assert.ok(
      v3.subarray(6).equals(v4.subarray(6)),
      "fixtures must differ only in the version field"
    );

    assert.throws(
      () => parseMetaDat(v3),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /unsupported version 3\b/);
        assert.match(err.message, /global_position_index/);
        assert.match(err.message, /one line high/);
        return true;
      },
      "a v3 container must be refused by name, not read one line high"
    );
  });

  test("every version below 4 is refused", () => {
    for (const version of [0, 1, 2, 3]) {
      assert.throws(
        () => parseMetaDat(buildMetaDat(version, FIELDS)),
        new RegExp(`unsupported version ${version}\\b`),
        `v${version} must be refused`
      );
    }
  });

  test("a future version is refused too, without the encode claim", () => {
    assert.throws(
      () => parseMetaDat(buildMetaDat(5, FIELDS)),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /unsupported version 5\b/);
        assert.ok(
          !/one line high/.test(err.message),
          "v5 postdates the correction; the shifted-encode diagnosis does not apply"
        );
        return true;
      }
    );
  });

  test("readCtfsMetaDat answers a v4 container and drops a v3 one", () => {
    const v4Dir = writeTraceFolder(buildMinimalCtfs([["meta.dat", buildMetaDat(4, FIELDS)]]));
    const v4Rejections: string[] = [];
    const v4Meta = readCtfsMetaDat(v4Dir, (message) => v4Rejections.push(message));
    assert.deepStrictEqual(v4Rejections, [], "a v4 container must not be rejected");
    assert.ok(v4Meta, "a v4 container must be readable end to end");
    assert.deepStrictEqual(v4Meta.paths, FIELDS.paths);
    assert.strictEqual(v4Meta.program, FIELDS.program);

    const v3Dir = writeTraceFolder(buildMinimalCtfs([["meta.dat", buildMetaDat(3, FIELDS)]]));
    const rejections: string[] = [];
    const v3Meta = readCtfsMetaDat(v3Dir, (message) => rejections.push(message));
    assert.strictEqual(v3Meta, undefined, "a v3 container must not yield metadata");
    assert.strictEqual(rejections.length, 1, "the refusal must be reported, not swallowed");
    assert.match(rejections[0], /unsupported version 3\b/);
    assert.match(rejections[0], /global_position_index/);
    assert.ok(rejections[0].includes(v3Dir), "the report must name the container it refused");

    fs.rmSync(v4Dir, { recursive: true, force: true });
    fs.rmSync(v3Dir, { recursive: true, force: true });
  });
});
