import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/** Write JSON only when its parsed value differs, preserving harness-owned formatting on a no-op. */
export function writeJsonFile(filePath: string, data: Record<string, unknown>): boolean {
  const next = JSON.stringify(data, null, 2) + '\n';
  try {
    if (isDeepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), JSON.parse(next))) return false;
  } catch { /* file absent — proceed */ }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic write — every agent config write (settings.json, hooks.json,
  // mcp.json) under the global install lands at user-home paths shared
  // with the agent's own content; a torn write to ~/.claude/settings.json
  // would lose user-authored settings.
  atomicWriteFileSync(filePath, next);
  return true;
}

/** Write a JSON file, or delete it if the object is empty. */
export function writeOrDeleteJsonFile(filePath: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  } else {
    writeJsonFile(filePath, data);
  }
}
