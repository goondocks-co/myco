import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../hash.js';
import { estimateTokens } from '@myco/constants.js';
import { parserFor } from '../parsers/registry.js';
import type { CanopyEntry } from '../../db/schema.js';

/** Files larger than this are skipped (mechanical heuristic). */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Bytes inspected for the binary-content sniff. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Reason a file was rejected; null when scanFile produced an entry. */
export type ScanRejection = 'too_large' | 'binary' | 'symlink' | 'missing' | 'read_error';

export interface ScanFileOptions {
  projectId: string;
  machineId: string;
  projectRoot: string;
  /** Repo-relative, forward-slash. */
  relPath: string;
  now: number; // epoch seconds
  maxBytes?: number;
}

export interface ScanFileSuccess {
  ok: true;
  entry: CanopyEntry;
}

export interface ScanFileSkip {
  ok: false;
  reason: ScanRejection;
}

export type ScanFileResult = ScanFileSuccess | ScanFileSkip;

/**
 * Read one file and produce a CanopyEntry — pure aside from the read.
 * Skips binary content, symlinks, and files exceeding `maxBytes`.
 */
export function scanFile(opts: ScanFileOptions): ScanFileResult {
  const abs = path.join(opts.projectRoot, opts.relPath);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!stat.isFile()) return { ok: false, reason: 'missing' };
  if (stat.size > maxBytes) return { ok: false, reason: 'too_large' };

  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return { ok: false, reason: 'read_error' };
  }
  if (looksBinary(buf)) return { ok: false, reason: 'binary' };

  const content = buf.toString('utf8');
  const lineCount = countLines(content);
  const parser = parserFor(opts.relPath);
  const parsed = parser({
    path: opts.relPath,
    content,
    sizeBytes: buf.length,
    lineCount,
  });

  const entry: CanopyEntry = {
    project_id: opts.projectId,
    machine_id: opts.machineId,
    path: opts.relPath,
    content_hash: sha256Hex(buf),
    size_bytes: buf.length,
    token_estimate: estimateTokens(content),
    line_count: lineCount,
    language: parsed.language,
    exports_json: parsed.exports.length > 0 ? JSON.stringify(parsed.exports) : null,
    imports_json: parsed.imports.length > 0 ? JSON.stringify(parsed.imports) : null,
    top_comment: parsed.topComment,
    mechanical_updated_at: opts.now,
    llm_description: null,
    llm_updated_at: null,
  };

  return { ok: true, entry };
}

/** A NUL byte in the leading prefix is a robust binary signal. */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  // Trailing newline shouldn't count as an extra blank line.
  if (content.charCodeAt(content.length - 1) === 10) n--;
  return n;
}
