import type { RelationalStore } from './adapters.js';
import { MAX_ID_CHARS } from '@goondocks/myco-shared/member-protocol';

/** The inactivity window for recent attention evidence. */
export const OUTCOME_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const VIEW_READ_REFUSAL_KEY = 'attention.view_read_refusal';

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
