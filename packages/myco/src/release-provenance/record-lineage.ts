/**
 * Map a release-state source row (`sessions` / `prompt_batches`) to the
 * derived embeddable records that should inherit its release classification.
 *
 * Lineage preference:
 *   - prompt_batch lineage is more specific than session lineage
 *   - a record with prompt_batch_id inherits ONLY from that batch's source row
 *   - a record with session_id and NULL prompt_batch_id inherits from its session
 *
 * Artifacts and skill_records have no first-class session/batch lineage in v1
 * and are intentionally excluded; their release_state stays `unknown` until a
 * stronger evidence path lands.
 */

import type { Database } from 'bun:sqlite';
import { getDatabase } from '@myco/db/client.js';
import {
  appendProjectCondition,
  type ProjectScope,
} from '@myco/db/queries/project-scope.js';
import type { ReleaseNamespace } from '@myco/db/queries/release-provenance.js';

export interface DerivedRecord {
  namespace: ReleaseNamespace;
  recordId: string;
}

export interface FindDerivedRecordsInput {
  sourceNamespace: ReleaseNamespace;
  sourceRecordId: string;
  scope: ProjectScope;
  db?: Database;
}

export function findDerivedRecords(input: FindDerivedRecordsInput): DerivedRecord[] {
  const { sourceNamespace, sourceRecordId, scope } = input;
  const db = input.db ?? getDatabase();
  if (sourceNamespace !== 'sessions' && sourceNamespace !== 'prompt_batches') {
    return [];
  }

  const out: DerivedRecord[] = [];
  const tables: Array<{ table: 'spores' | 'plans'; namespace: ReleaseNamespace }> = [
    { table: 'spores', namespace: 'spores' },
    { table: 'plans', namespace: 'plans' },
  ];

  for (const { table, namespace } of tables) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (sourceNamespace === 'prompt_batches') {
      conditions.push('prompt_batch_id = ?');
      params.push(Number(sourceRecordId));
    } else {
      // Only inherit from session when a more specific batch lineage is absent.
      conditions.push('session_id = ? AND prompt_batch_id IS NULL');
      params.push(sourceRecordId);
    }
    appendProjectCondition(conditions, params, scope);
    const rows = db.prepare(
      `SELECT id FROM ${table} WHERE ${conditions.join(' AND ')}`,
    ).all(...params) as Array<{ id: string | number }>;
    for (const row of rows) out.push({ namespace, recordId: String(row.id) });
  }

  return out;
}
