import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write `data` as JSON to `filePath`. Returns `true` when a write
 * occurred, `false` when the on-disk content already matched the
 * serialized form (no-op). The content-diff gate lets idempotent install
 * passes distinguish "newly installed" from "already configured" without
 * carrying before/after snapshots through the call graph.
 */
export function writeJsonFile(filePath: string, data: Record<string, unknown>): boolean {
  const next = JSON.stringify(data, null, 2) + '\n';
  try {
    if (fs.readFileSync(filePath, 'utf-8') === next) return false;
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
