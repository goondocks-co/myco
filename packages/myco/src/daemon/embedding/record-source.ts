/**
 * SqliteRecordSource — queries the record store for rows that need embedding.
 *
 * Delegates to existing helpers from `@myco/db/queries/embeddings.js` where
 * possible (markEmbedded, clearEmbedded, getUnembedded). Custom queries are
 * used for spore status filtering, metadata enrichment, and content retrieval.
 */

import { getDatabase } from '@myco/db/client.js';
import {
  markEmbedded as dbMarkEmbedded,
  clearEmbedded as dbClearEmbedded,
  getUnembedded,
  assertValidTable as assertValidNamespace,
  EMBEDDABLE_TABLES,
  EMBEDDABLE_TEXT_COLUMNS,
  type EmbeddableTable,
} from '@myco/db/queries/embeddings.js';
import { parseCanopyRecordId } from '@myco/canopy/hydrate.js';
import type { DomainMetadata, EmbeddableRecordSource } from '@myco/daemon/embedding/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Spore status that qualifies for embedding. */
const ACTIVE_STATUS = 'active';

/** Build metadata for a session row. */
function sessionMetadata(row: Record<string, unknown>): DomainMetadata {
  return {
    ...(row.project_root != null ? { project_root: row.project_root as string } : {}),
    ...(row.created_at != null ? { created_at: row.created_at as number } : {}),
  };
}

/** Build metadata for a spore row. */
function sporeMetadata(row: Record<string, unknown>): DomainMetadata {
  return {
    ...(row.status != null ? { status: row.status as string } : {}),
    ...(row.session_id != null ? { session_id: row.session_id as string } : {}),
    ...(row.observation_type != null ? { observation_type: row.observation_type as string } : {}),
    ...(row.created_at != null ? { created_at: row.created_at as number } : {}),
  };
}

/** Build metadata for an artifact row — empty. */
function emptyMetadata(): DomainMetadata {
  return {};
}

/** Build metadata for a plan row. */
function planMetadata(row: Record<string, unknown>): DomainMetadata {
  return {
    ...(row.session_id != null ? { session_id: row.session_id as string } : {}),
    ...(row.source_path != null ? { source_path: row.source_path as string } : {}),
    ...(row.created_at != null ? { created_at: row.created_at as number } : {}),
  };
}

/** Build metadata for a skill_records row. */
function skillRecordMetadata(row: Record<string, unknown>): DomainMetadata {
  return {
    ...(row.status != null ? { status: row.status as string } : {}),
    ...(row.name != null ? { name: row.name as string } : {}),
    ...(row.created_at != null ? { created_at: row.created_at as number } : {}),
  };
}

/** Build metadata for a canopy_entries row. */
function canopyEntryMetadata(row: Record<string, unknown>): DomainMetadata {
  return {
    ...(row.project_id != null ? { project_id: row.project_id as string } : {}),
    ...(row.path != null ? { path: row.path as string } : {}),
    ...(row.language != null ? { language: row.language as string } : {}),
    ...(row.llm_updated_at != null ? { created_at: row.llm_updated_at as number } : {}),
  };
}

/** Get the metadata builder for a given namespace. */
function metadataFor(namespace: EmbeddableTable, row: Record<string, unknown>): DomainMetadata {
  switch (namespace) {
    case 'sessions':
      return sessionMetadata(row);
    case 'spores':
      return sporeMetadata(row);
    case 'plans':
      return planMetadata(row);
    case 'artifacts':
      return emptyMetadata();
    case 'skill_records':
      return skillRecordMetadata(row);
    case 'canopy_entries':
      return canopyEntryMetadata(row);
  }
}

// ---------------------------------------------------------------------------
// SqliteRecordSource
// ---------------------------------------------------------------------------

export class SqliteRecordSource implements EmbeddableRecordSource {
  /**
   * Get rows that need embedding (embedded=0, content non-null).
   *
   * For spores: additionally filters WHERE status = 'active'.
   * For sessions: delegates to getUnembedded (which filters summary IS NOT NULL).
   */
  getEmbeddableRows(namespace: string, limit: number): Array<{
    id: string;
    text: string;
    metadata: DomainMetadata;
  }> {
    assertValidNamespace(namespace);

    if (namespace === 'spores') {
      return this.getUnembeddedActiveSpores(limit);
    }

    if (namespace === 'skill_records') {
      return this.getUnembeddedActiveSkillRecords(limit);
    }

    if (namespace === 'canopy_entries') {
      return this.getUnembeddedCanopyEntries(limit);
    }

    // For sessions/plans/artifacts: delegate to getUnembedded, then enrich with metadata
    const rows = getUnembedded(namespace, limit);
    const db = getDatabase();
    return rows.map((row) => {
      const fullRow = db.prepare(`SELECT * FROM ${namespace} WHERE id = ?`).get(row.id) as Record<string, unknown>;
      return {
        id: String(row.id),
        text: row.text,
        metadata: metadataFor(namespace as EmbeddableTable, fullRow),
      };
    });
  }

  /**
   * Get IDs of all records that should have embeddings.
   *
   * - sessions: those with a non-null summary
   * - spores: those with status = 'active'
   * - plans/artifacts: those with non-null content
   */
  getActiveRecordIds(namespace: string): string[] {
    assertValidNamespace(namespace);
    const db = getDatabase();

    switch (namespace) {
      case 'sessions': {
        const rows = db.prepare(
          `SELECT id FROM sessions WHERE summary IS NOT NULL`,
        ).all() as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }
      case 'spores': {
        const rows = db.prepare(
          `SELECT id FROM spores WHERE status = ?`,
        ).all(ACTIVE_STATUS) as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }
      case 'plans': {
        const rows = db.prepare(
          `SELECT id FROM plans WHERE content IS NOT NULL`,
        ).all() as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }
      case 'artifacts': {
        const rows = db.prepare(
          `SELECT id FROM artifacts WHERE content IS NOT NULL`,
        ).all() as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }
      case 'skill_records': {
        const rows = db.prepare(
          `SELECT id FROM skill_records WHERE status = ?`,
        ).all(ACTIVE_STATUS) as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }
      case 'canopy_entries': {
        const rows = db.prepare(
          `SELECT (project_id || ':' || path) AS id
             FROM canopy_entries
            WHERE llm_description IS NOT NULL`,
        ).all() as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }
    }
  }

  /**
   * Fetch content + metadata for specific record IDs.
   *
   * Returns same shape as getEmbeddableRows but for specific records.
   * Empty ids array returns empty result.
   */
  getRecordContent(namespace: string, ids: string[]): Array<{
    id: string;
    text: string;
    metadata: DomainMetadata;
  }> {
    assertValidNamespace(namespace);

    if (ids.length === 0) return [];

    const db = getDatabase();
    const textCol = EMBEDDABLE_TEXT_COLUMNS[namespace as EmbeddableTable];

    if (namespace === 'canopy_entries') {
      const parsedIds = ids
        .map((id) => parseCanopyRecordId(id))
        .filter((p): p is { projectId: string; path: string } => p !== null);
      if (parsedIds.length === 0) return [];
      const placeholders = parsedIds.map(() => '(?, ?)').join(', ');
      const args = parsedIds.flatMap((p) => [p.projectId, p.path]);
      const rows = db.prepare(
        `SELECT *, (project_id || ':' || path) AS id, ${textCol} AS text
           FROM canopy_entries
          WHERE (project_id, path) IN (VALUES ${placeholders})`,
      ).all(...args) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        text: row.text as string,
        metadata: canopyEntryMetadata(row),
      }));
    }

    const placeholders = ids.map(() => '?').join(', ');

    const rows = db.prepare(
      `SELECT *, ${textCol} AS text FROM ${namespace} WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      text: row.text as string,
      metadata: metadataFor(namespace as EmbeddableTable, row),
    }));
  }

  /** Mark a record as embedded. Delegates to existing helper. */
  markEmbedded(namespace: string, id: string): void {
    if (namespace === 'canopy_entries') {
      const parsed = parseCanopyRecordId(id);
      if (parsed === null) return;
      getDatabase().prepare(
        `UPDATE canopy_entries SET embedded = 1 WHERE project_id = ? AND path = ?`,
      ).run(parsed.projectId, parsed.path);
      return;
    }
    dbMarkEmbedded(namespace, id);
  }

  /** Clear the embedded flag on a record. Delegates to existing helper. */
  clearEmbedded(namespace: string, id: string): void {
    if (namespace === 'canopy_entries') {
      const parsed = parseCanopyRecordId(id);
      if (parsed === null) return;
      getDatabase().prepare(
        `UPDATE canopy_entries SET embedded = 0 WHERE project_id = ? AND path = ?`,
      ).run(parsed.projectId, parsed.path);
      return;
    }
    dbClearEmbedded(namespace, id);
  }

  /**
   * Clear the embedded flag on all records, optionally scoped to a namespace.
   *
   * If namespace is omitted, clears all embeddable tables.
   */
  clearAllEmbedded(namespace?: string): void {
    // canopy_entries is intentionally handled by the generic loop below — it has no
    // composite-key concerns at this layer because the UPDATE applies to all rows.
    const db = getDatabase();

    if (namespace !== undefined) {
      assertValidNamespace(namespace);
      db.prepare(`UPDATE ${namespace} SET embedded = 0`).run();
      return;
    }

    for (const table of EMBEDDABLE_TABLES) {
      db.prepare(`UPDATE ${table} SET embedded = 0`).run();
    }
  }

  /**
   * Count rows that need embedding — lightweight SELECT COUNT(*), no row materialization.
   */
  getPendingCount(namespace: string): number {
    assertValidNamespace(namespace);
    const db = getDatabase();

    if (namespace === 'canopy_entries') {
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM canopy_entries WHERE embedded = 0 AND llm_description IS NOT NULL`,
      ).get() as { cnt: number };
      return Number(row.cnt);
    }

    const contentFilter = namespace === 'sessions' ? ' AND summary IS NOT NULL' : '';
    const statusFilter = (namespace === 'spores' || namespace === 'skill_records') ? ` AND status = '${ACTIVE_STATUS}'` : '';

    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM ${namespace} WHERE embedded = 0${contentFilter}${statusFilter}`,
    ).get() as { cnt: number };

    return Number(row.cnt);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Custom query for spores: embedded=0 AND status='active'. */
  private getUnembeddedActiveSpores(limit: number): Array<{
    id: string;
    text: string;
    metadata: DomainMetadata;
  }> {
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT id, content AS text, status, session_id, observation_type
       FROM spores
       WHERE embedded = 0 AND status = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(ACTIVE_STATUS, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      text: row.text as string,
      metadata: sporeMetadata(row),
    }));
  }

  /** Custom query for skill_records: embedded=0 AND status='active'. */
  private getUnembeddedActiveSkillRecords(limit: number): Array<{
    id: string;
    text: string;
    metadata: DomainMetadata;
  }> {
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT id, description AS text, status, name
       FROM skill_records
       WHERE embedded = 0 AND status = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(ACTIVE_STATUS, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      text: row.text as string,
      metadata: skillRecordMetadata(row),
    }));
  }

  /** Custom query for canopy_entries: embedded=0 AND llm_description IS NOT NULL. */
  private getUnembeddedCanopyEntries(limit: number): Array<{
    id: string;
    text: string;
    metadata: DomainMetadata;
  }> {
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT (project_id || ':' || path) AS id,
              project_id, path, language, llm_updated_at,
              llm_description AS text
         FROM canopy_entries
        WHERE embedded = 0 AND llm_description IS NOT NULL
        ORDER BY mechanical_updated_at ASC
        LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      text: row.text as string,
      metadata: canopyEntryMetadata(row),
    }));
  }
}
