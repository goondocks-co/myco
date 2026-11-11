import type { RelationalStore } from '../../core/adapters.js';
import type { VectorMetadata } from '../../core/embedding/vectors.js';
import { SEARCH_PREVIEW_CHARS } from '@goondocks/myco-shared/search-types';
import { CURRENT_EMBEDDING_SOURCES, EMBEDDING_RELEASE_COLUMNS, embeddingSourceSelect } from '../embedding-sources.js';
import { notTombstonedSql } from '../session-read-model.js';
import { read, readSet } from '../index.js';

/** An embedding receipt joined to the source record its vector stands for. */
export interface EmbeddingHitRow extends VectorMetadata {
  project_id: string;
  namespace: string;
  title: string;
  text: string;
  blob_key: string | null;
  prompt_id: string | null;
  vector_id: string;
  neighbor_mean: number | null;
  neighbor_std: number | null;
}

/** A bounded character prefix, including embedded NULs; blob slicing advances past each NUL. */
function previewSql(text: string): string {
  return `(WITH RECURSIVE chunks(prefix, rest, remaining) AS (
    SELECT '', ${text}, ${SEARCH_PREVIEW_CHARS}
    UNION ALL SELECT prefix || substr(rest, 1, remaining) || char(0),
      CAST(substr(CAST(rest AS BLOB), instr(CAST(rest AS BLOB), x'00') + 1) AS TEXT),
      remaining - length(substr(rest, 1, remaining)) - 1
    FROM chunks WHERE remaining > 0 AND instr(CAST(rest AS BLOB), x'00') > 0
      AND length(substr(rest, 1, remaining)) < remaining
  ) SELECT prefix || substr(rest, 1, remaining) FROM chunks
    WHERE remaining = 0 OR instr(CAST(rest AS BLOB), x'00') = 0
      OR length(substr(rest, 1, remaining)) = remaining LIMIT 1)`;
}

/** Receipt ids drive every source lookup; CROSS JOIN preserves that indexed order. */
function hydrationSql(preview: boolean): string {
  const branches = CURRENT_EMBEDDING_SOURCES.map((source) => `SELECT s.*, v.revision,
    ${EMBEDDING_RELEASE_COLUMNS},
    r.id AS vector_id, r.neighbor_mean, r.neighbor_std
    FROM hits r CROSS JOIN (${embeddingSourceSelect(source, preview ? previewSql(source.text) : "''")}) s
    CROSS JOIN embedding_versions v
    WHERE r.type = '${source.type}' AND s.project_id = r.project_id AND s.record_id = r.record_id
      AND v.project_id = r.project_id AND v.type = r.type AND v.record_id = r.record_id AND v.revision = r.revision
      ${source.type === 'session' || source.type === 'plan' ? `AND ${notTombstonedSql('s')}` : ''}`);
  return `WITH hits AS MATERIALIZED (SELECT * FROM embedding_receipts
    WHERE project_id = ?1 AND model_key = ?2 AND ready = 1 AND id IN (SELECT value FROM json_each(?3)))
    ${branches.join(' UNION ALL ')}`;
}

type Hydration = [project: string, model: string, ids: string];
const withPreview = read<Hydration, EmbeddingHitRow>({ name: 'embeddingHits.withPreview', sql: hydrationSql(true) });
const withoutPreview = read<Hydration, EmbeddingHitRow>({ name: 'embeddingHits.withoutPreview', sql: hydrationSql(false) });

/** The ready receipts among `receiptIds` for the model, each joined to its eligible, current source; a preview prefixes the text to the search preview length. */
export async function embeddingHitRows(db: RelationalStore, request: { project: string; modelKey: string; receiptIds: readonly string[]; preview: boolean }): Promise<EmbeddingHitRow[]> {
  const { project, modelKey, receiptIds, preview } = request;
  const [rows] = await readSet(db, (preview ? withPreview : withoutPreview).bind(project, modelKey, JSON.stringify(receiptIds)));
  return rows;
}
