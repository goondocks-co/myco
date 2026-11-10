import type { RelationalStore } from '../../core/adapters.js';
import { first, read } from '../index.js';

const offset = read<[artifact: string], { revision_offset: number }>({ name: 'raw.restoreRevisionOffset', sql:
  'SELECT revision_offset FROM raw_restore_revisions WHERE artifact_hash=?1' });

/** The revision interval an artifact's imported claim ranges were reserved at, or null before its restore reserved one. */
export async function reservedRestoreOffset(db: RelationalStore, artifactHash: string): Promise<number | null> {
  return (await first(db, offset.bind(artifactHash)))?.revision_offset ?? null;
}
