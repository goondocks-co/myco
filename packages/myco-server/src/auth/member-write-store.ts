import type { RelationalStore } from '../core/adapters.js';
import { boundWriteGuardStore } from '../db/kernel/guarded-store.js';
import { MEMBER_WRITE_REFUSED, memberWriteAuthority } from '../db/auth/write-authority.js';
import { refused } from '../db/index.js';
import { MemberWriteRefused } from './member-write-refusal.js';
export { MemberWriteRefused } from './member-write-refusal.js';

export interface MemberWriteActor { memberId: string; authority: 'admin' | 'member' }

/** The request's mutations retain its admitted authority at each atomic write. */
export function memberWriteStore(db: RelationalStore, memberId: string, authority: 'admin' | 'member', onRefused: () => void = () => {}): RelationalStore {
  return boundWriteGuardStore(db, () => memberWriteAuthority.bind(memberId, authority === 'admin' ? null : memberId), error => {
    if (refused(error, MEMBER_WRITE_REFUSED)) { onRefused(); throw new MemberWriteRefused(); }
    throw error;
  });
}
