import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { writeGuardBatch, writeGuardStore } from '../core/write-guard-store.js';
import { memberWritePredicate } from './authorization.js';
import { MemberWriteRefused } from './member-write-refusal.js';
export { MemberWriteRefused } from './member-write-refusal.js';

const REFUSED_PATH = '$[myco_member_write_refused]';

export interface MemberWriteActor { memberId: string; authority: 'admin' | 'member' }

const assertion = (db: RelationalStore, actor: MemberWriteActor) => () => db.prepare(`SELECT CASE WHEN ${memberWritePredicate('?', '?')}
  THEN 1 ELSE json_extract('[]', ?) END AS admitted`).bind(actor.memberId, actor.authority === 'admin' ? null : actor.memberId, REFUSED_PATH);

function refusal(error: unknown): never {
  if (error instanceof Error && error.message.includes(REFUSED_PATH.slice(1))) throw new MemberWriteRefused();
  throw error;
}

/** The request's mutations retain its admitted authority at each atomic write. */
export function memberWriteStore(db: RelationalStore, memberId: string, authority: 'admin' | 'member', onRefused: () => void = () => {}): RelationalStore {
  return writeGuardStore(db, assertion(db, { memberId, authority }), error => {
    try { return refusal(error); }
    catch (caught) { if (caught instanceof MemberWriteRefused) onRefused(); throw caught; }
  });
}

/** A dispatch's identity rows and run record share one live-actor admission. */
export function memberWriteBatch(db: RelationalStore, actor: MemberWriteActor, statements: PreparedStatement[]) {
  return writeGuardBatch(db, assertion(db, actor), refusal, statements);
}
