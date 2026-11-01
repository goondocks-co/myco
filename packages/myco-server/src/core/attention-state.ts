import type { RelationalStore } from './adapters.js';
import { MAX_ID_CHARS } from '@goondocks/myco-shared/member-protocol';

/** The inactivity window for recent attention evidence. */
export const OUTCOME_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const DOCUMENT_PUBLISH_FAILURE_KEY = 'attention.document_publish_failure';

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

export interface DocumentPublicationStoppedFinding {
  kind: 'document_publication_stopped';
  tone: 'warn';
  transcripts: number;
  lastStoppedAt: number;
  failure: string;
}

/** Transcripts whose document publication stands stopped. A stop that can clear leaves once its session's next pass resumes it. */
export async function documentPublicationStoppedFinding(db: RelationalStore): Promise<DocumentPublicationStoppedFinding | null> {
  const row = await db.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS at, MIN(failure) AS failure FROM transcript_publication WHERE state = 'failed'`)
    .first<{ n: number; at: number | null; failure: string | null }>();
  if (row === null || row.n === 0) return null;
  return { kind: 'document_publication_stopped', tone: 'warn', transcripts: row.n, lastStoppedAt: Number(row.at), failure: row.failure ?? 'unknown' };
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
