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

// Header scan is bounded on two axes: a byte budget (session_meta can be
// large when it embeds the full system prompt — Codex sessions routinely
// exceed 16 KB; 128 KB covers all known cases) and a line-count budget
// (Claude Code's structural fields appear within the first handful of
// lines, so there's no need to keep scanning a multi-megabyte transcript).
const HEADER_BYTE_BUDGET = 131072;
const MAX_HEADER_LINES = 25;

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
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
      const buf = Buffer.alloc(HEADER_BYTE_BUDGET);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      if (bytesRead === 0) return null;

      const chunk = buf.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n').slice(0, MAX_HEADER_LINES);

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
