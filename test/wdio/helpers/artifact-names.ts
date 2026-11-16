/**
 * File names for WDIO diagnostics artifacts.
 *
 * CI uploads `test/wdio/diagnostics/` (copied to `wdio-diagnostics/`) with
 * `actions/upload-artifact`, which refuses the WHOLE artifact when any one
 * file path contains a character it does not accept on every platform:
 * `"`, `:`, `<`, `>`, `|`, `*`, `?`, carriage return and line feed (see
 * https://github.com/actions/toolkit/blob/main/packages/artifact/src/internal/upload/path-and-artifact-name-validation.ts).
 * Diagnostics file names are built from test titles, and a title such as
 * `event log contains "result"` once cost a failing run all 50 of its
 * diagnostics files.
 *
 * Every diagnostics file name therefore goes through `artifactFileName`
 * (`writeDiag`, `screenshot` and, through `screenshot`, the `afterTest` hook
 * in `wdio.conf.ts`). It keeps only `[A-Za-z0-9._-]`, which is a strict
 * subset of what upload-artifact and every file system accept, and never
 * lets a `/` or `\` from a title create or escape a directory.
 *
 * This module has no WDIO imports so that it can be unit-tested with plain
 * Node (`artifact-names.test.ts`, `just test-wdio-helpers`).
 */
import { createHash } from 'node:crypto'

/** Longest stem `artifactSafeName` returns by default. Long enough to keep a
 *  test title readable, short enough to stay far below the 255-byte file-name
 *  limit once a prefix and an extension are added. */
export const DEFAULT_ARTIFACT_NAME_MAX_LENGTH = 100

/** Hex digits of the label's SHA-256 appended when the name is lossy. */
const HASH_LENGTH = 8

/** Any run of characters outside the portable set. */
const UNSAFE_RUN = /[^A-Za-z0-9._-]+/g

/** An extension `artifactFileName` keeps as it is: a dot and 1-10
 *  alphanumerics, e.g. `.png`, `.json`. */
const SAFE_EXTENSION = /\.[A-Za-z0-9]{1,10}$/

function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').substring(0, HASH_LENGTH)
}

/**
 * Map an arbitrary label (usually built from a test title) to a file-name
 * stem made only of `[A-Za-z0-9._-]`.
 *
 * - Each run of other characters (quotes, colons, slashes, backslashes,
 *   whitespace, control characters, non-ASCII) becomes one `-`.
 * - Leading and trailing `-` and `.` are trimmed, so the result is never
 *   `.`, `..` or a hidden file.
 * - When that changed the label, or the label is longer than `maxLength`,
 *   the stem is cut and `-<8 hex digits of the label's SHA-256>` appended.
 *   Two different labels that sanitise or truncate to the same text
 *   therefore still get different names, and the same label always gets the
 *   same name. A label that is already safe and short is returned unchanged.
 *
 * @param label     the text to turn into a name
 * @param maxLength the longest result allowed (at least `HASH_LENGTH + 2`)
 */
export function artifactSafeName(
  label: string,
  maxLength: number = DEFAULT_ARTIFACT_NAME_MAX_LENGTH,
): string {
  if (!Number.isInteger(maxLength) || maxLength < HASH_LENGTH + 2) {
    throw new RangeError(
      `artifactSafeName: maxLength must be an integer >= ${HASH_LENGTH + 2}, got ${maxLength}`,
    )
  }
  const cleaned = label.replace(UNSAFE_RUN, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (cleaned === label && cleaned.length > 0 && cleaned.length <= maxLength) {
    return cleaned
  }
  // Lossy: keep as much of the readable text as fits beside the hash.
  const room = maxLength - HASH_LENGTH - 1
  const head = cleaned.substring(0, room).replace(/[-.]+$/, '')
  const hash = shortHash(label)
  return head.length > 0 ? `${head}-${hash}` : `unnamed-${hash}`
}

/**
 * `artifactSafeName` for a whole file name: a safe extension (`.png`,
 * `.json`, …) is kept as it is and the stem before it is sanitised, so
 * truncation never cuts the extension off. A name with no safe extension is
 * sanitised as a whole.
 *
 * @param fileName  e.g. `browser-console-${label}.json`
 * @param maxLength the longest stem allowed (the extension is extra)
 */
export function artifactFileName(
  fileName: string,
  maxLength: number = DEFAULT_ARTIFACT_NAME_MAX_LENGTH,
): string {
  const match = SAFE_EXTENSION.exec(fileName)
  if (match && match.index > 0) {
    return artifactSafeName(fileName.substring(0, match.index), maxLength) + match[0]
  }
  return artifactSafeName(fileName, maxLength)
}
