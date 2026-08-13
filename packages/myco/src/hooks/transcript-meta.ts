/**
 * Read structural metadata from an agent's transcript file so capture rules
 * can make decisions based on it — e.g., detecting sub-agent thread spawns
 * or SDK-launched runs that have real transcript files but aren't
 * user-initiated sessions.
 *
 * Two transcript shapes are supported:
 *
 *   1. Wrapped session_meta (Codex): the first JSONL line is
 *      `{ type: "session_meta", payload: {...} }`. The `payload` object is
 *      returned directly — unchanged fast path, exactly as before.
 *   2. Headerless (Claude Code): the first line carries no recognizable
 *      meta wrapper. In that case every field on the first line is still
 *      returned as-is (a plain object is treated as direct meta, matching
 *      prior behavior), then a bounded number of SUBSEQUENT header lines
 *      are scanned and shallow-merged in: only SCALAR values (string,
 *      number, boolean) are pulled from each parsed record, first-value-wins
 *      per key. Nested objects on lines after the first are never merged —
 *      only line 1's own nested fields remain reachable — so the result
 *      stays predictable rather than an accumulating deep-merge of
 *      unrelated records. This surfaces fields like Claude Code's
 *      `entrypoint` ("sdk-py" / "sdk-ts" / "cli"), which only appear a few
 *      lines into the file on attachment/user records, not on line 1.
 *
 * Returns null if the file doesn't exist, isn't readable, or contains no
 * parseable JSON within the scanned window.
 */

import fs from 'node:fs';

// Header scan is bounded on two axes, read incrementally so the common case
// stays a single cheap syscall:
//   - HEADER_READ_CHUNK: the size of each read. Most transcripts satisfy the
//     MAX_HEADER_LINES quota (or hit EOF) within the first chunk.
//   - HEADER_HARD_CAP: the absolute ceiling on bytes scanned. Some agents
//     (Claude Code's Agent-SDK entrypoint transcripts observed in the wild)
//     embed a full review prompt on LINE 1 — 87 KB+, pushing the structural
//     `entrypoint` field (which lives a few lines later) past a single fixed
//     128 KB read. Reading continues, one chunk at a time, until either
//     MAX_HEADER_LINES complete lines have been seen or this cap is hit —
//     so CPU/IO stays bounded even on a transcript whose header never
//     satisfies the line quota.
const HEADER_READ_CHUNK = 131072;
const HEADER_HARD_CAP = 1048576;
const MAX_HEADER_LINES = 25;
const NEWLINE_BYTE = 0x0a;

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function countNewlines(buf: Buffer): number {
  let count = 0;
  let idx = -1;
  while ((idx = buf.indexOf(NEWLINE_BYTE, idx + 1)) !== -1) count++;
  return count;
}

/**
 * Read up to `HEADER_HARD_CAP` bytes from `fd`, in `HEADER_READ_CHUNK`-sized
 * reads, stopping as soon as `MAX_HEADER_LINES` newline-terminated lines
 * have been seen or the file ends. Returns the bytes read and whether EOF
 * was reached (vs. stopping because the cap or line quota was hit) — EOF
 * matters for whether a newline-less tail is a genuine last line (a file
 * with no trailing newline) or a record truncated by the cap.
 */
function readHeader(fd: number): { data: Buffer; reachedEOF: boolean } {
  let total = Buffer.alloc(0);
  let reachedEOF = false;

  while (total.length < HEADER_HARD_CAP) {
    const toRead = Math.min(HEADER_READ_CHUNK, HEADER_HARD_CAP - total.length);
    const chunk = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, chunk, 0, toRead, total.length);
    if (bytesRead === 0) {
      reachedEOF = true;
      break;
    }
    total = Buffer.concat([total, chunk.subarray(0, bytesRead)]);
    if (bytesRead < toRead) {
      reachedEOF = true;
      break;
    }
    if (countNewlines(total) >= MAX_HEADER_LINES) break;
  }

  return { data: total, reachedEOF };
}

/**
 * Read and parse transcript metadata from a transcript file.
 *
 * @param transcriptPath - Absolute path to the JSONL transcript.
 * @returns The merged metadata object, or null on any failure.
 */
export function readTranscriptMeta(transcriptPath: string): Record<string, unknown> | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const { data, reachedEOF } = readHeader(fd);
      if (data.length === 0) return null;

      const text = data.toString('utf-8');
      const rawLines = text.split('\n');
      // A buffer that doesn't end with '\n' AND wasn't cut off by EOF has a
      // final element that is a record truncated by the hard cap, not a
      // complete line — drop it. (EOF with no trailing newline is a
      // legitimate single-line-with-no-terminator file; keep it.)
      const lastIsTruncated = !reachedEOF && !text.endsWith('\n');
      const usableLines = lastIsTruncated ? rawLines.slice(0, -1) : rawLines;
      const lines = usableLines.slice(0, MAX_HEADER_LINES);

      // Line 1 itself exceeded the hard cap without ever completing —
      // nothing usable was read.
      const firstLine = lines[0];
      if (!firstLine) return null;

      let firstEntry: unknown;
      try {
        firstEntry = JSON.parse(firstLine);
      } catch {
        firstEntry = undefined;
      }

      // session_meta entries have { type: "session_meta", payload: {...} } —
      // unchanged fast path, returned as-is without consulting later lines.
      if (
        typeof firstEntry === 'object' &&
        firstEntry !== null &&
        (firstEntry as Record<string, unknown>).type === 'session_meta' &&
        typeof (firstEntry as Record<string, unknown>).payload === 'object'
      ) {
        return (firstEntry as Record<string, unknown>).payload as Record<string, unknown>;
      }

      // Headerless shape: line 1 (if a direct object) seeds the result with
      // ALL of its fields, nested included, so its own meta stays fully
      // reachable. Later lines contribute SCALAR fields only, first-value-wins.
      const merged: Record<string, unknown> =
        typeof firstEntry === 'object' && firstEntry !== null ? { ...(firstEntry as Record<string, unknown>) } : {};

      for (const line of lines.slice(1)) {
        if (!line) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // partial trailing line, or a non-JSON entry
        }
        if (typeof entry !== 'object' || entry === null) continue;
        for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
          if (key in merged) continue; // first-value-wins
          if (!isScalar(value)) continue; // scalars only from lines after the first
          merged[key] = value;
        }
      }

      return Object.keys(merged).length > 0 ? merged : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
