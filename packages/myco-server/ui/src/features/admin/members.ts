import { useMembers } from '../../hooks/use-access';
import { useMe } from '../../hooks/use-me';
import { memberLabel } from '../../lib/member-name';
import { MYCO_MEMBER_ID } from '../today/words';
import type { MemberRow } from './wire';

/** What Myco's own account reads as wherever its name would appear. */
export const MYCO_NAME = 'Myco';

/**
 * Whether a member is Myco's own account rather than a person: the one every
 * run Myco dispatches signs in as. The server's `system` flag says so once it
 * sends it; until then the harness's own id does.
 */
export function isSystemMember(member: Pick<MemberRow, 'id' | 'system'>): boolean {
  return member.system === true || member.id === MYCO_MEMBER_ID;
}

/** The people: every member but Myco's own account. */
export function peopleOf<T extends Pick<MemberRow, 'id' | 'system'>>(members: readonly T[]): T[] {
  return members.filter((member) => !isSystemMember(member));
}

/**
 * A member's name as an admin page shows it: "Myco" for Myco's own account,
 * the label when it names them, else null. Never the member's id.
 */
export function memberName(member: Pick<MemberRow, 'id' | 'label' | 'system'>): string | null {
  if (isSystemMember(member)) return MYCO_NAME;
  return memberLabel(member);
}

/**
 * Who a member id is: a name, or null. Every member reads the members list, so
 * a label that names a person names them to everyone. A member whose label is
 * only their id (a join or a carried-over machine names nothing better) is
 * named by the GitHub login they signed in with, to themselves alone: the
 * login of anyone else is never listed. Null for an id the list does not hold
 * or a teammate named only by id; a caller words the null ("saved 2 h ago",
 * "by a member") and never shows the id.
 */
export function useMemberNames(): (id: string | null | undefined) => string | null {
  const members = useMembers();
  const me = useMe().data;
  const viewerId = me?.member?.id ?? null;
  const login = me?.login !== undefined && me.login !== '' ? me.login : null;
  const byId = new Map((members.data?.members ?? []).map((member) => [member.id, member]));
  return (id) => {
    if (id == null) return null;
    const member = byId.get(id);
    const named = member !== undefined ? memberName(member) : id === MYCO_MEMBER_ID ? MYCO_NAME : null;
    return named ?? (id === viewerId ? login : null);
  };
}
