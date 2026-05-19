/**
 * Atomic write + idempotent clear for JSON sentinel files (update
 * in-progress, last update error, etc.). Read with `readJsonFile`
 * from `@myco/utils/json`.
 *
 * Writes go through `atomicWriteFileSync` so a reader racing the
 * writer either sees the previous valid content or the new one,
 * never a torn prefix. Callers needing specific file modes (e.g.
 * daemon.json's 0o600 for the bearer token) supply `{ mode }`.
 */

import path from 'node:path';
import fs from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.js';

export interface WriteJsonSentinelOptions {
  /** File mode passed through to atomicWriteFileSync. */
  mode?: number;
}

export function writeJsonSentinel(
  filePath: string,
  value: unknown,
  opts: WriteJsonSentinelOptions = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(value, null, 2) + '\n', { mode: opts.mode });
}

export function clearJsonSentinel(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}
