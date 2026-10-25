import { viewMaterialVersionQuery } from './view-store.js';
import type { RelationalStore } from '../core/adapters.js';
import type { ReadScope } from './scope.js';

export interface MaterialVersionSelection {
  kind: string;
  identity: string;
  contentHash: string;
  hashScheme: string;
  materialSeq: number | null;
}

/** Selected rows retain historical stamps; unstamped content resolves only an exact current binding. */
export async function readMaterialVersion(
  db: RelationalStore,
  scope: ReadScope,
  session: string,
  selected: MaterialVersionSelection,
) {
  const row = await viewMaterialVersionQuery(db)
    .bind(
      selected.materialSeq,
      scope.projectId,
      session,
      selected.kind,
      selected.identity,
      selected.contentHash,
      selected.hashScheme,
    )
    .first<{ material_seq: number | null }>();
  if (row === null) throw new Error('material_version_read_unavailable');
  return row.material_seq === null
    ? { state: 'superseded' as const }
    : { state: 'versioned' as const, materialSeq: row.material_seq };
}
