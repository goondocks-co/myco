import { zipSync, strToU8 } from 'fflate';
import type { BundleFile } from './types.js';

/** Build a zip in memory. Deterministic input order; level 6 is fine for JSONL. */
export function createZip(files: BundleFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    entries[f.path] = typeof f.data === 'string' ? strToU8(f.data) : f.data;
  }
  return zipSync(entries, { level: 6 });
}
