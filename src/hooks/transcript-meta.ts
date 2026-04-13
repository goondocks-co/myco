/**
 * Read the first JSON line (session_meta) from an agent's transcript file.
 *
 * Every supported agent writes a JSONL transcript where the first entry
 * is a `session_meta` record containing session identity, source info,
 * model, and other structural signals. This reader extracts that record
 * so capture rules can make decisions based on it — e.g., detecting
 * sub-agent thread spawns that have real transcript files but aren't
 * user-initiated sessions.
 *
 * Returns the parsed `payload` object from the session_meta entry, or
 * null if the file doesn't exist, isn't readable, or doesn't contain
 * valid session_meta JSON.
 */

import fs from 'node:fs';

/**
 * Read and parse the session_meta payload from a transcript file.
 *
 * @param transcriptPath - Absolute path to the JSONL transcript.
 * @returns The session_meta payload object, or null on any failure.
 */
export function readTranscriptMeta(transcriptPath: string): Record<string, unknown> | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      // Read enough bytes for the first line. Session meta can be large
      // when it embeds the full system prompt (base_instructions) — Codex
      // sessions routinely exceed 16 KB. 128 KB covers all known cases.
      const buf = Buffer.alloc(131072);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      if (bytesRead === 0) return null;

      const chunk = buf.toString('utf-8', 0, bytesRead);
      const newlineIdx = chunk.indexOf('\n');
      const firstLine = newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk;
      if (!firstLine) return null;

      const entry = JSON.parse(firstLine);

      // session_meta entries have { type: "session_meta", payload: {...} }
      if (entry?.type === 'session_meta' && typeof entry.payload === 'object') {
        return entry.payload as Record<string, unknown>;
      }

      // Some agents may write the meta directly without the wrapper
      if (typeof entry === 'object' && entry !== null) {
        return entry as Record<string, unknown>;
      }

      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
