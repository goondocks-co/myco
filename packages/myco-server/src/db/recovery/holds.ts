/**
 * Recovery holds: what defers deletion while a backup is taken.
 *
 * Every statement of a hold's lifecycle is spelled once here, as a template over the SQL expressions for its values, so
 * both targets and both holders transition a hold the same way. Inside the Deployment each template runs as a kernel
 * statement over numbered slots and answers the row it moved. A hosted operator sends the same template through the
 * provider's own command path, which binds no parameters, so `recoveryHoldSql` renders the values into it: a token is a
 * UUID, a holder and a reason are from closed sets, and an instant is a number. Anything else is refused before a
 * statement exists.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { first, read, write } from '../index.js';

/** Who took a hold: this Deployment's own export producer, or an operator's full backup. */
type RecoveryHoldHolder = 'producer' | 'operator';
/** Why an operator released its hold: the artifact completed, or the operator gave it up. */
export type OperatorHoldRelease = 'complete' | 'abandoned';

/** A hold row as an inspection reads it. */
interface RecoveryHoldRow {
  token: string;
  holder: RecoveryHoldHolder;
  acquiredAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
}

/**
 * How long an open operator hold defers this Deployment's own exports. An operator backup runs for minutes to hours;
 * one open longer than a day has been abandoned without its release, and automatic backups do not wait on it for ever.
 * Deletion still defers to it until it is released.
 */
export const OPERATOR_HOLD_DEFERS_MS = 24 * 60 * 60 * 1000;

const deferSince = (now: number): number => Math.max(0, now - OPERATOR_HOLD_DEFERS_MS);

/** The templates: each takes the SQL expression for every value it names. */
const TEMPLATES = {
  acquire(holder: RecoveryHoldHolder, token: string, now: string, since: string): string {
    // A producer defers to an operator backup opened in the last day, decided in the same statement that opens its
    // hold. The operator opens its hold first and then reads for the producer's, and writes are serialized, so of two
    // that race exactly one sees the other and neither exports beside it.
    const deferring = holder === 'producer'
      ? ` AND NOT EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL AND holder = 'operator' AND acquired_at > ${since})`
      : '';
    return `INSERT INTO recovery_holds (token, acquired_at, holder)
              SELECT ${token}, ${now}, '${holder}'
               WHERE NOT EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL AND holder = '${holder}')${deferring}
              ON CONFLICT DO NOTHING`;
  },
  deferringOperator(since: string): string {
    return `SELECT token, acquired_at FROM recovery_holds WHERE released_at IS NULL AND holder = 'operator' AND acquired_at > ${since}`;
  },
  releaseProducer(token: string, now: string, why: string): string {
    return `UPDATE recovery_holds SET released_at = ${now}, release_reason = ${why}, released_by = 'producer'
             WHERE token = ${token} AND released_at IS NULL AND holder = 'producer'`;
  },
  releaseOperator(token: string, now: string, why: string): string {
    return `UPDATE recovery_holds SET released_at = ${now}, release_reason = ${why}, released_by = 'operator'
             WHERE token = ${token} AND released_at IS NULL AND holder = 'operator'`;
  },
  reading(token: string): string {
    return `SELECT (SELECT holder FROM recovery_holds WHERE token = ${token}) AS holder,
                   (SELECT acquired_at FROM recovery_holds WHERE token = ${token}) AS acquired_at,
                   (SELECT released_at FROM recovery_holds WHERE token = ${token}) AS released_at,
                   (SELECT release_reason FROM recovery_holds WHERE token = ${token}) AS release_reason,
                   (SELECT value FROM schema_meta WHERE key = 'deployment_id') AS deployment_id,
                   (SELECT value FROM schema_meta WHERE key = 'version') AS schema_version`;
  },
  open(holder: RecoveryHoldHolder): string {
    return `SELECT token, acquired_at FROM recovery_holds WHERE released_at IS NULL AND holder = '${holder}'`;
  },
};

/** A hold token: what `crypto.randomUUID` mints, and nothing that could carry a quote into a statement. */
const HOLD_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
/** A release reason: the producer's settled attempt, or an operator's completion or abandonment. */
const RELEASE_REASON = /^[A-Za-z0-9 ._-]{1,64}$/;

function token(value: string): string {
  if (!HOLD_TOKEN.test(value)) throw new Error('a recovery hold token is outside its grammar');
  return `'${value}'`;
}
function reason(value: string): string {
  if (!RELEASE_REASON.test(value)) throw new Error('a recovery hold release reason is outside its grammar');
  return `'${value}'`;
}
function instant(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('a recovery hold instant is a whole number of milliseconds');
  return String(value);
}
function operatorReason(why: OperatorHoldRelease): string {
  if (why !== 'complete' && why !== 'abandoned') throw new Error('an operator recovery hold is released as complete or abandoned');
  return `'${why}'`;
}

/** Each lifecycle statement with its values rendered in, for a path that binds no parameters. */
export const recoveryHoldSql = {
  acquire: (held: string, now: number, holder: RecoveryHoldHolder): string =>
    TEMPLATES.acquire(holder, token(held), instant(now), instant(deferSince(now))),
  /** The open operator hold a producer defers to now, if any. */
  deferringOperator: (now: number): string => TEMPLATES.deferringOperator(instant(deferSince(now))),
  releaseProducer: (held: string, now: number, why: string): string => TEMPLATES.releaseProducer(token(held), instant(now), reason(why)),
  releaseOperator: (held: string, now: number, why: OperatorHoldRelease): string => TEMPLATES.releaseOperator(token(held), instant(now), operatorReason(why)),
  /**
   * One row answering what a hold token is and what Deployment holds it, so a caller never pairs a hold with an
   * identity it read separately.
   */
  reading: (held: string): string => TEMPLATES.reading(token(held)),
  open: (holder: RecoveryHoldHolder): string => TEMPLATES.open(holder),
};

/** What one `reading` row says: the hold, and the Deployment that answered for it. */
interface RecoveryHoldReadingRow {
  holder: string | null;
  acquired_at: number | null;
  released_at: number | null;
  release_reason: string | null;
  deployment_id: string | null;
  schema_version: string | null;
}

type HeldRow = { token: string; acquired_at: number };

const acquireStatements = {
  producer: write<[token: string, now: number, since: number], { token: string }>({ name: 'recovery.acquireProducerHold',
    sql: `${TEMPLATES.acquire('producer', '?1', '?2', '?3')} RETURNING token` }),
  operator: write<[token: string, now: number], { token: string }>({ name: 'recovery.acquireOperatorHold',
    sql: `${TEMPLATES.acquire('operator', '?1', '?2', '')} RETURNING token` }),
};
const deferringOperator = read<[since: number], HeldRow>({ name: 'recovery.deferringOperatorHold', sql: TEMPLATES.deferringOperator('?1') });
const releaseProducer = write<[token: string, now: number, reason: string], { token: string }>({ name: 'recovery.releaseProducerHold',
  sql: `${TEMPLATES.releaseProducer('?1', '?2', '?3')} RETURNING token` });
const releaseOperator = write<[token: string, now: number, reason: string], { token: string }>({ name: 'recovery.releaseOperatorHold',
  sql: `${TEMPLATES.releaseOperator('?1', '?2', '?3')} RETURNING token` });
const reading = read<[token: string], RecoveryHoldReadingRow>({ name: 'recovery.readHold', sql: TEMPLATES.reading('?1') });
const openStatements = {
  producer: read<[], HeldRow>({ name: 'recovery.openProducerHold', sql: TEMPLATES.open('producer') }),
  operator: read<[], HeldRow>({ name: 'recovery.openOperatorHold', sql: TEMPLATES.open('operator') }),
};

/** Values the kernel binds pass the same grammar as values rendered in. */
const checked = (held: string): string => { token(held); return held; };
const checkedInstant = (value: number): number => { instant(value); return value; };

/** The open operator hold a producer defers to now, or null. */
export async function deferringOperatorHold(db: RelationalStore, now: number): Promise<{ token: string; acquiredAt: number } | null> {
  const row = await first(db, deferringOperator.bind(checkedInstant(deferSince(now))));
  return row === null ? null : { token: row.token, acquiredAt: Number(row.acquired_at) };
}

/**
 * Opens a hold of `holder` under `token`, answering false when one of that holder is already open: at most one of each
 * holder is open, and the unique index on open holds per holder decides it inside the insert. A token already used
 * answers false too, so retrying the same token is safe and never opens a second hold.
 *
 * An operator hold and a producer hold coexist: a full operator backup does not stop this Deployment admitting its own
 * export, and deletion defers while either is open (`HOLD_OPEN`).
 */
export async function acquireRecoveryHold(db: RelationalStore, held: string, now: number, holder: RecoveryHoldHolder = 'producer'): Promise<boolean> {
  const acquire = holder === 'producer'
    ? acquireStatements.producer.bind(checked(held), checkedInstant(now), checkedInstant(deferSince(now)))
    : acquireStatements.operator.bind(checked(held), checkedInstant(now));
  return (await first(db, acquire)) !== null;
}

/**
 * Releases the open producer hold `token` with its reason, answering whether this call released it. A released hold
 * stays released, and an operator hold is never released here: the database refuses it.
 */
export async function releaseRecoveryHold(db: RelationalStore, held: string, now: number, why: string): Promise<boolean> {
  reason(why);
  return (await first(db, releaseProducer.bind(checked(held), checkedInstant(now), why))) !== null;
}

/**
 * Releases the open operator hold `token`, answering whether this call released it. The one transition an operator hold
 * accepts; a released hold stays released, so a repeated release is safe.
 */
export async function releaseOperatorHold(db: RelationalStore, held: string, now: number, why: OperatorHoldRelease): Promise<boolean> {
  operatorReason(why);
  return (await first(db, releaseOperator.bind(checked(held), checkedInstant(now), why))) !== null;
}

/**
 * The Deployment a hold reading answers for: what a destination binds its backup to.
 *
 * Both fields come from the same statement as the hold. A reading that cannot name both is `null`, never a partly
 * filled identity.
 */
export interface RecoveryHoldSource {
  deploymentId: string;
  schemaVersion: number;
}

/** The hold `token` names and the Deployment answering for it, as one row. */
export async function readRecoveryHold(db: RelationalStore, held: string): Promise<{ hold: RecoveryHoldRow | null; source: RecoveryHoldSource | null }> {
  return recoveryHoldOf(held, await first(db, reading.bind(checked(held))));
}

/** One reading row as a hold and the identity it came with; the identity is what a destination binds its hold to. */
export function recoveryHoldOf(held: string, row: RecoveryHoldReadingRow | null): { hold: RecoveryHoldRow | null; source: RecoveryHoldSource | null } {
  const source = recoveryHoldSourceOf(row);
  if (row === null || row.holder === null) return { hold: null, source };
  return {
    hold: { token: held, holder: row.holder as RecoveryHoldHolder, acquiredAt: Number(row.acquired_at), releasedAt: row.released_at, releaseReason: row.release_reason },
    source,
  };
}

/** The identity a reading row carries, or null when it names no Deployment or no schema version this code can read. */
function recoveryHoldSourceOf(row: Pick<RecoveryHoldReadingRow, 'deployment_id' | 'schema_version'> | null): RecoveryHoldSource | null {
  const deploymentId = row?.deployment_id ?? null;
  const schemaVersion = Number(row?.schema_version ?? Number.NaN);
  if (deploymentId === null || deploymentId === '' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) return null;
  return { deploymentId, schemaVersion };
}

/** The open hold of `holder`, or null. */
export async function openRecoveryHold(db: RelationalStore, holder: RecoveryHoldHolder): Promise<{ token: string; acquiredAt: number } | null> {
  const row = await first(db, openStatements[holder].bind());
  return row === null ? null : { token: row.token, acquiredAt: Number(row.acquired_at) };
}
