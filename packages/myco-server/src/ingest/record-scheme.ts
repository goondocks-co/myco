import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { assertRecordIdentityDeclaration, isRecordIdScheme, LEGACY_RECORD_ID_SCHEME, type RecordIdScheme } from '@goondocks/myco-shared/record-identity';
import type { RelationalStore } from '../core/adapters.js';

const DECLARED_RECORD_IDENTITIES: Readonly<Record<string, unknown>> = Object.fromEntries(
  CAPTURE_RULE_BUNDLES.filter(bundle => bundle.recordIdentity !== undefined).map(bundle => [bundle.name, bundle.recordIdentity]),
);

/** The current record scheme each manifest declares. */
export const DECLARED_RECORD_SCHEMES: Readonly<Record<string, RecordIdScheme>> = Object.fromEntries(
  CAPTURE_RULE_BUNDLES.flatMap(bundle => bundle.recordIdentity === undefined ? [] : [[bundle.name, bundle.recordIdentity.scheme]]),
);

export type RecordSchemeRefusal = 'record_identity_scheme_conflict' | 'record_identity_scheme_unsupported';

export class RecordSchemeError extends Error {
  constructor(readonly code: RecordSchemeRefusal) {
    super(code);
    this.name = 'RecordSchemeError';
  }
}

const SQL_SAFE = /^[a-z0-9-]+$/;

/** A registering transcript's immutable pin, selected from validated manifest declarations. */
export function admittedRecordScheme(agent: string | null, declarations: Readonly<Record<string, unknown>> = DECLARED_RECORD_IDENTITIES): { sql: string; params: unknown[] } {
  const arms = Object.entries(declarations).map(([name, declaration]) => {
    try {
      assertRecordIdentityDeclaration(name, declaration);
      if (!SQL_SAFE.test(name) || !SQL_SAFE.test(declaration.scheme)) throw new Error();
    } catch {
      throw new RecordSchemeError('record_identity_scheme_unsupported');
    }
    return `WHEN '${name}' THEN '${declaration.scheme}'`;
  });
  return arms.length === 0
    ? { sql: '?', params: [LEGACY_RECORD_ID_SCHEME] }
    : { sql: `COALESCE(CASE ? ${arms.join(' ')} END, ?)`, params: [agent, LEGACY_RECORD_ID_SCHEME] };
}

const RESTORE_TRANSCRIPTS_PER_READ = 50;
const transcriptKey = (row: Record<string, unknown>): string => JSON.stringify([row.project_id, row.transcript_id]);

function artifactPin(row: Record<string, unknown>): RecordIdScheme {
  if (!Object.hasOwn(row, 'record_identity_scheme')) return LEGACY_RECORD_ID_SCHEME;
  if (!isRecordIdScheme(row.record_identity_scheme)) throw new RecordSchemeError('record_identity_scheme_unsupported');
  return row.record_identity_scheme;
}

/** Refuse any artifact whose transcript pins disagree with one another or with the destination snapshot. */
export async function restoreRecordSchemeDecisions(db: RelationalStore, rows: readonly Record<string, unknown>[]): Promise<void> {
  const pins = new Map<string, RecordIdScheme>();
  const hold = (row: Record<string, unknown>): void => {
    const key = transcriptKey(row);
    const pin = artifactPin(row);
    const held = pins.get(key);
    if (held !== undefined && held !== pin) throw new RecordSchemeError('record_identity_scheme_conflict');
    pins.set(key, pin);
  };
  for (const row of rows) hold(row);
  const keys = [...pins.keys()];
  for (let at = 0; at < keys.length; at += RESTORE_TRANSCRIPTS_PER_READ) {
    const { results } = await db.prepare(`SELECT t.project_id, t.transcript_id, t.record_identity_scheme
        FROM json_each(?) j JOIN transcripts t ON t.project_id = json_extract(j.value, '$[0]') AND t.transcript_id = json_extract(j.value, '$[1]')`)
      .bind(`[${keys.slice(at, at + RESTORE_TRANSCRIPTS_PER_READ).join(',')}]`).all<Record<string, unknown>>();
    for (const row of results) hold(row);
  }
}
