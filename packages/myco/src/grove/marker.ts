/**
 * Shared on-disk marker helpers for resumable Grove operations.
 *
 * Both the move orchestrator and the claim/release flow persist their
 * state machines on JSON markers that must survive crash mid-write:
 * readers either see the prior valid contents or the new ones.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';

export function writeMarkerJson<T>(filePath: string, marker: T): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(marker, null, 2));
}

/**
 * Read and validate a marker. Returns null when the file is missing,
 * unreadable, malformed JSON, or fails the supplied validator. Throwing
 * validators bubble up so a "this is a real schema problem" case is
 * distinguishable from "no marker present".
 */
export function readMarkerJson<T>(
  filePath: string,
  validate: (raw: unknown) => T | null,
): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validate(parsed);
}

/**
 * Enumerate `*.json` files in `dir` (non-recursive) that pass `predicate`
 * on their absolute path.
 */
export function findMarkerFiles(
  dir: string,
  predicate: (filePath: string) => boolean,
): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    const full = path.join(dir, entry.name);
    if (predicate(full)) out.push(full);
  }
  return out;
}
