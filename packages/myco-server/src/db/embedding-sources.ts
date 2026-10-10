import { occurredAt, presentedStatus } from './session-dates.js';
import { processedResourceProofSql } from '../core/processed-resources.js';

/** Every embeddable table: its vector type, key, the columns its revision follows, and each clause of its `embedding_sources` SELECT. */
export const EMBEDDING_SOURCES = [
  { table: 'sessions', type: 'session', id: 'session_id', columns: 'title, summary, started_at, ended_at',
    title: "COALESCE(title, 'Session')", text: "COALESCE(title, '') || char(10) || summary", blob: 'NULL',
    status: "CASE WHEN ended_at IS NULL THEN 'active' ELSE 'completed' END", session: 'session_id', prompt: 'NULL', created: 'COALESCE(started_at, first_received_at)', observation: "''", eligible: "summary IS NOT NULL AND trim(summary) <> ''" },
  { table: 'spores', type: 'spore', id: 'id', columns: 'content, context, status, session_id, prompt_id, observation_type, created_at',
    title: 'observation_type', text: "content || char(10) || COALESCE(context, '')", blob: 'NULL', status: 'status', session: 'session_id', prompt: 'prompt_id', created: 'created_at', observation: 'observation_type', eligible: "status = 'active'" },
  { table: 'plans', type: 'plan', id: 'plan_key', columns: 'title, content, blob_key, content_hash, status, session_id, prompt_id, created_at',
    title: "COALESCE(title, 'Plan')", text: "COALESCE(title, '') || char(10) || COALESCE(content, '')", blob: 'blob_key', status: 'status', session: 'session_id', prompt: 'prompt_id', created: 'created_at', observation: "''", eligible: 'content IS NOT NULL OR blob_key IS NOT NULL' },
  { table: 'skill_records', type: 'skill', id: 'id', columns: 'name, display_name, description, status, generation, created_at',
    title: "COALESCE(NULLIF(display_name, ''), name)", text: "name || char(10) || description", blob: 'NULL', status: 'status', session: 'NULL', prompt: 'NULL', created: 'created_at', observation: "''", eligible: "status = 'active'" },
] as const;

/** One embedding source, with every clause of its SELECT as text. */
export type Source = { readonly [K in keyof (typeof EMBEDDING_SOURCES)[number]]: string };

const unionOf = (list: readonly Source[]): string => list.map((s) => `SELECT project_id, '${s.type}' AS type, '${s.table}' AS namespace, ${s.id} AS record_id,
  ${s.title} AS title, ${s.text} AS text, ${s.blob} AS blob_key, ${s.status} AS status,
  COALESCE(${s.session}, '') AS session_id, ${s.prompt} AS prompt_id, ${s.created} AS created_at, ${s.observation} AS observation_type
  FROM ${s.table} WHERE ${s.eligible}`).join(' UNION ALL ');

/** The `embedding_sources` view over a set of sources. */
export const embeddingSourcesView = (list: readonly Source[]): string => `CREATE VIEW IF NOT EXISTS embedding_sources AS SELECT s.*, v.revision,
    COALESCE((SELECT k.state FROM knowledge_release_state k WHERE k.project_id = s.project_id AND k.namespace = s.namespace AND k.record_id = s.record_id ORDER BY k.checked_at DESC, k.id LIMIT 1), '') AS release_state,
    COALESCE((SELECT k.confidence FROM knowledge_release_state k WHERE k.project_id = s.project_id AND k.namespace = s.namespace AND k.record_id = s.record_id ORDER BY k.checked_at DESC, k.id LIMIT 1), '') AS release_confidence
    FROM (${unionOf(list)}) s JOIN embedding_versions v ON v.project_id = s.project_id AND v.type = s.type AND v.record_id = s.record_id`;

/** The sources with a session dated and stated by what it is presented with; what a search filters on. */
export const SOURCES_WITH_PRESENTED_SESSION_DATE: readonly Source[] = EMBEDDING_SOURCES.map((s) => s.table === 'sessions'
  ? { ...s, created: occurredAt(), status: presentedStatus() }
  : s);


/** The current source eligibility and presentation clauses. */
export const CURRENT_EMBEDDING_SOURCES: readonly Source[] = SOURCES_WITH_PRESENTED_SESSION_DATE.map((source) => source.type === 'plan'
  ? { ...source, eligible: `content IS NOT NULL OR (blob_key IS NOT NULL AND ${processedResourceProofSql('plans.project_id', 'plan', 'plans.plan_key', 'plans.blob_key')})` }
  : source);
