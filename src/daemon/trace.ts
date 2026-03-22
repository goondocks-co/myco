/**
 * Shared JSONL trace file utilities.
 *
 * Used by DigestEngine and ConsolidationEngine to read/write append-only
 * trace records with timestamp caching.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Read the last JSON record from a JSONL file. Returns null if file is missing or empty. */
export function readLastRecord<T = Record<string, unknown>>(filePath: string): T | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return null;
  }
  if (!content) return null;
  const lines = content.split('\n');
  const lastLine = lines[lines.length - 1];
  try {
    return JSON.parse(lastLine) as T;
  } catch {
    return null;
  }
}

/** Read the last JSON record's `timestamp` field from a JSONL file. Returns null if file is missing or empty. */
export function readLastTimestamp(filePath: string): string | null {
  return readLastRecord<{ timestamp: string }>(filePath)?.timestamp ?? null;
}

/** Append a JSON record to a JSONL file, creating parent directories if needed. */
export function appendTraceRecord(filePath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
}
