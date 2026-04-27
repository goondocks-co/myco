/**
 * Compose the PreToolUse injection blob from a CanopyEntry row.
 *
 * Blob shape (Tier 1 — mechanical only):
 *
 *   [canopy] <path> — <tok> tok, <lines> lines
 *     exports: a, b, c
 *     imports: ./x, ./y
 *     top: "first JSDoc / docstring / H1"
 *   [meta] File anatomy from Myco. ...
 *
 * Blob shape (Tier 2 — with llm_description):
 *
 *   [canopy] <path> — <tok> tok, <lines> lines
 *     exports: a, b, c
 *     imports: ./x, ./y
 *     summary: "one-sentence summary"
 *   [meta] File summary from Myco. ...
 *
 * The `[meta]` line is the teaching layer — without it the blob is passive
 * data; with it the agent knows the decision the blob supports. Phrased as
 * a suggestion, never a directive.
 *
 * Safety cap: a blob exceeding ~200 tokens (800 chars) gets its longest
 * payload field truncated first (summary > top > imports > exports). The
 * structural `[canopy]` and `[meta]` lines are always preserved.
 */

import type { CanopyEntry } from '../../db/schema.js';
import { parseJsonStringArray } from '../../utils/parse-json-array.js';

const META_WITH_SUMMARY =
  '[meta] File summary from Myco. If this already answers your question, skipping the full read may be appropriate.';
const META_ANATOMY_ONLY =
  '[meta] File anatomy from Myco. If exports + top line already answer your question, skipping the full read may be appropriate.';

const BLOB_CHAR_CAP = 800; // ~200 tokens at 4 chars/token
const TOP_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 240;
const EXPORTS_MAX_ITEMS = 10;
const IMPORTS_MAX_ITEMS = 6;

interface ComposeFields {
  exports: string[];
  imports: string[];
  topComment: string | null;
  summary: string | null;
}

function buildBlob(entry: CanopyEntry, fields: ComposeFields): string {
  const lines: string[] = [];
  lines.push(
    `[canopy] ${entry.path} — ${entry.token_estimate} tok, ${entry.line_count} lines`,
  );
  if (fields.exports.length > 0) {
    lines.push(`  exports: ${fields.exports.slice(0, EXPORTS_MAX_ITEMS).join(', ')}`);
  }
  if (fields.imports.length > 0) {
    lines.push(`  imports: ${fields.imports.slice(0, IMPORTS_MAX_ITEMS).join(', ')}`);
  }
  if (fields.summary) {
    lines.push(`  summary: "${fields.summary.slice(0, SUMMARY_MAX_CHARS)}"`);
  } else if (fields.topComment) {
    lines.push(`  top: "${fields.topComment.slice(0, TOP_MAX_CHARS)}"`);
  }
  lines.push(fields.summary ? META_WITH_SUMMARY : META_ANATOMY_ONLY);
  return lines.join('\n');
}

function freshDescription(entry: CanopyEntry): string | null {
  if (!entry.llm_description) return null;
  if (entry.llm_updated_at === null) return null;
  return entry.llm_updated_at >= entry.mechanical_updated_at ? entry.llm_description : null;
}

/**
 * Compose the injection blob for an entry. Returns the textual payload
 * the daemon hands back to the agent via hookSpecificOutput.additionalContext.
 */
export function composeBlob(entry: CanopyEntry): string {
  const fields: ComposeFields = {
    exports: parseJsonStringArray(entry.exports_json),
    imports: parseJsonStringArray(entry.imports_json),
    topComment: entry.top_comment,
    summary: freshDescription(entry),
  };

  let blob = buildBlob(entry, fields);
  if (blob.length <= BLOB_CHAR_CAP) return blob;

  // Truncation order: summary > top > imports > exports. Structural lines
  // are always preserved; we only shrink payload fields.
  if (fields.summary && fields.summary.length > 60) {
    fields.summary = `${fields.summary.slice(0, 60)}…`;
    blob = buildBlob(entry, fields);
    if (blob.length <= BLOB_CHAR_CAP) return blob;
  }

  if (fields.topComment && fields.topComment.length > 60) {
    fields.topComment = `${fields.topComment.slice(0, 60)}…`;
    blob = buildBlob(entry, fields);
    if (blob.length <= BLOB_CHAR_CAP) return blob;
  }

  if (fields.imports.length > 3) {
    fields.imports = fields.imports.slice(0, 3);
    blob = buildBlob(entry, fields);
    if (blob.length <= BLOB_CHAR_CAP) return blob;
  }

  if (fields.exports.length > 5) {
    fields.exports = fields.exports.slice(0, 5);
    blob = buildBlob(entry, fields);
  }

  return blob;
}

/** Quick token estimator — same 4 chars/token heuristic used elsewhere in Canopy. */
export function blobTokenCost(blob: string): number {
  return Math.ceil(blob.length / 4);
}
