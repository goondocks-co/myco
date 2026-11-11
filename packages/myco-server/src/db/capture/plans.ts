/**
 * A captured `plan` event's projection. A plan is a Project-shared editorial row any member may update: the newest
 * event wins whole, identical content keeps its display fields and administrator, and an event that names no status
 * leaves the row's alone. Tags follow every event at least as new as the row. Every write lands only when this request
 * stored the event.
 */
import { read, write, type Bound } from '../index.js';
import { storedByThisRequest } from './event-write.js';
import type { Stored } from './sessions.js';

const prior = read<[project: string, plan: string], { content_hash: string; origin_path: string | null; updated_at: number }>({ name: 'capture.planPrior', sql:
  'SELECT content_hash, origin_path, updated_at FROM plans WHERE project_id = ?1 AND plan_key = ?2' });

/** The event is newer than the row, or ties on client time and wins the row's tiebreak. */
const NEWER = '(excluded.updated_at > plans.updated_at OR (excluded.updated_at = plans.updated_at AND excluded.event_id < plans.event_id))';
/** Identical content: the same body and title, and the same status where the event names one (`?18`). */
const IDENTICAL = '(excluded.content_hash = plans.content_hash AND excluded.title IS plans.title AND (?18 = 0 OR excluded.status = plans.status))';
const MOVES = `${NEWER} AND NOT ${IDENTICAL}`;
const follows = (column: string, when: string) => `${column} = CASE WHEN ${when} THEN excluded.${column} ELSE plans.${column} END`;

type PlanRow = [project: string, plan: string, session: string, event: string, machine: string, title: string | null, content: string | null,
  blob: string | null, contentHash: string | null, status: string, originPath: string | null, source: string | null, prompt: string | null,
  createdAt: number, token: string, receivedAt: number, nonce: string, statusGiven: number];
const upsert = write<PlanRow, { applied: number }>({ name: 'capture.planUpsert', sql:
  `INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, origin_path, source,
      prompt_id, updated_by, created_at, updated_at, token_id, received_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, CAST(?14 AS INTEGER), CAST(?14 AS INTEGER), ?15, CAST(?16 AS INTEGER)
      WHERE ${storedByThisRequest('?1', '?4', '?17')}
    ON CONFLICT(project_id,plan_key) DO UPDATE SET
      ${['event_id', 'updated_at', 'received_at', 'token_id'].map(column => follows(column, NEWER)).join(', ')},
      ${['title', 'content', 'blob_key', 'content_hash', 'origin_path'].map(column => follows(column, MOVES)).join(', ')},
      status = CASE WHEN ${NEWER} AND ?18 = 1 THEN excluded.status ELSE plans.status END,
      prompt_id = CASE WHEN ${NEWER} THEN COALESCE(excluded.prompt_id, plans.prompt_id) ELSE plans.prompt_id END,
      source = CASE WHEN ${NEWER} THEN COALESCE(excluded.source, plans.source) ELSE plans.source END,
      updated_by = CASE WHEN ${MOVES} THEN NULL ELSE plans.updated_by END,
      created_at = MIN(plans.created_at, excluded.created_at)
    RETURNING 1 AS applied` });

/** The event is at least as new as the row: newer on client time, or the event the row settled on. */
const CURRENT = 'EXISTS (SELECT 1 FROM plans WHERE project_id = ?1 AND plan_key = ?2 AND (updated_at < ?3 OR event_id = ?4))';
type Tags = [project: string, plan: string, createdAt: number, event: string, nonce: string];
const clearTags = write<Tags, { applied: number }>({ name: 'capture.planTagsClear', sql:
  `DELETE FROM tags WHERE project_id = ?1 AND entity_kind = 'plan' AND entity_id = ?2 AND ${CURRENT} AND ${storedByThisRequest('?1', '?4', '?5')}
    RETURNING 1 AS applied` });
const addTags = write<[...Tags, tags: string], { applied: number }>({ name: 'capture.planTagsAdd', sql:
  `INSERT OR IGNORE INTO tags (project_id, entity_kind, entity_id, tag)
    SELECT ?1, 'plan', ?2, value FROM json_each(?6) WHERE ${CURRENT} AND ${storedByThisRequest('?1', '?4', '?5')} RETURNING 1 AS applied` });

/** One plan event's values. */
export interface PlanEvent {
  planKey: string; machine: string; title: string | null; content: string | null; blob: string | null; contentHash: string | null;
  status: string; statusGiven: boolean; originPath: string | null; source: string | null; promptId: string | null;
  createdAt: number; token: string; receivedAt: number; tags: readonly string[];
}

const integer = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new Error('material_integer_invalid');
  return value;
};

/** The plan row as it stood before this event, read ahead of the projections. */
export const planPrior = (project: string, planKey: string) => prior.bind(project, planKey);

/** The plan row and its tags, in that order. */
export function planProjections(s: Stored, p: PlanEvent): Bound<{ applied: number }>[] {
  const tags: Tags = [s.project, p.planKey, p.createdAt, s.event, s.nonce];
  return [
    upsert.bind(s.project, p.planKey, s.session, s.event, p.machine, p.title, p.content, p.blob, p.contentHash, p.status, p.originPath, p.source,
      p.promptId, integer(p.createdAt), p.token, integer(p.receivedAt), s.nonce, p.statusGiven ? 1 : 0),
    clearTags.bind(...tags),
    addTags.bind(...tags, JSON.stringify(p.tags)),
  ];
}
