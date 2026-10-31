import type { RelationalStore } from './adapters.js';
import { MAX_ID_CHARS } from '@goondocks/myco-shared/member-protocol';

/** The inactivity window for recent attention evidence. */
export const OUTCOME_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const VIEW_READ_REFUSAL_KEY = 'attention.view_read_refusal';
export const DOCUMENT_PUBLISH_FAILURE_KEY = 'attention.document_publish_failure';

export interface ViewReadRefusalSample {
  projectId: string;
  sessionId: string;
  fence: number | null;
  code: 'view_state_inconsistent';
}

interface ViewReadRefusalRecord {
  count: number;
  last_refused_at: number;
  sample: ViewReadRefusalSample;
}

export interface ViewReadRefusalFinding {
  kind: 'view_state_inconsistent';
  tone: 'warn';
  refusals: number;
  lastRefusedAt: number;
}

/** One bounded record of observed refusals; a successful read never clears it. */
export async function recordViewReadRefusal(db: RelationalStore, sample: ViewReadRefusalSample, now: number): Promise<void> {
  if (sample.projectId.length > 64 || sample.sessionId.length > MAX_ID_CHARS) throw new Error('Refusal identity exceeds its storage bound');
  const value: ViewReadRefusalRecord = { count: 1, last_refused_at: now, sample };
  await db.prepare(`INSERT INTO schema_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=
    json_set(excluded.value,'$.count',CASE WHEN json_extract(schema_meta.value,'$.last_refused_at') >= ?
      THEN json_extract(schema_meta.value,'$.count') + 1 ELSE 1 END)`)
    .bind(VIEW_READ_REFUSAL_KEY, JSON.stringify(value), now - OUTCOME_LOOKBACK_MS).run();
}

/** Recent observed refusals, independent of the sample session's current state. */
export function viewReadRefusalFinding(raw: string | null, now: number): ViewReadRefusalFinding | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('count' in value) || !('last_refused_at' in value) ||
    typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 1 ||
    typeof value.last_refused_at !== 'number' || !Number.isSafeInteger(value.last_refused_at) || value.last_refused_at < 0) {
    throw new Error('Observed refusal metadata is invalid');
  }
  if (value.last_refused_at < now - OUTCOME_LOOKBACK_MS) return null;
  return { kind: 'view_state_inconsistent', tone: 'warn', refusals: value.count, lastRefusedAt: value.last_refused_at };
}

/** The latest session whose document pass failed, and the failure's server code. */
export interface DocumentPublishFailureSample {
  projectId: string;
  sessionId: string;
  failure: string;
}

export interface DocumentPublishFailureFinding {
  kind: 'document_publish_failed';
  tone: 'warn';
  failures: number;
  lastFailedAt: number;
  failure: string;
}

/** One bounded record of failed document passes; a later successful pass never clears it. */
export async function recordDocumentPublishFailure(db: RelationalStore, sample: DocumentPublishFailureSample, now: number): Promise<void> {
  if (sample.projectId.length > 64 || sample.sessionId.length > MAX_ID_CHARS || !/^[a-z][a-z0-9_]{0,63}$/.test(sample.failure)) {
    throw new Error('Publish failure identity exceeds its storage bound');
  }
  await db.prepare(`INSERT INTO schema_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=
    json_set(excluded.value,'$.count',CASE WHEN json_extract(schema_meta.value,'$.last_failed_at') >= ?
      THEN json_extract(schema_meta.value,'$.count') + 1 ELSE 1 END)`)
    .bind(DOCUMENT_PUBLISH_FAILURE_KEY, JSON.stringify({ count: 1, last_failed_at: now, sample }), now - OUTCOME_LOOKBACK_MS).run();
}

/** Recent failed document passes, whether or not the sample session has published after them. */
export function documentPublishFailureFinding(raw: string | null, now: number): DocumentPublishFailureFinding | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as { count?: unknown; last_failed_at?: unknown; sample?: { failure?: unknown } };
  if (typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 1
    || typeof value.last_failed_at !== 'number' || !Number.isSafeInteger(value.last_failed_at) || typeof value.sample?.failure !== 'string') {
    throw new Error('Publish failure metadata is invalid');
  }
  if (value.last_failed_at < now - OUTCOME_LOOKBACK_MS) return null;
  return { kind: 'document_publish_failed', tone: 'warn', failures: value.count, lastFailedAt: value.last_failed_at, failure: value.sample.failure };
}
