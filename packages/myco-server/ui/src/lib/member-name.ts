/**
 * A member as a person reads them. A member's label defaults to its own id when
 * a join names nothing better, and a member carried over from a machine is
 * labelled with the machine's id; neither is a name. Such a label reads as the
 * next thing given, the GitHub login where there is one, and never as the id.
 */

/** Ids a person never needs to see: members, runs, projects and credentials. */
const RAW_ID = /^(mem|run|proj|mt)_[\w-]{6,}$/;

/** The label when it names the member, or null when it is only the member's id in another shape. */
export function memberLabel(member: { id: string; label: string | null }): string | null {
  const label = member.label?.trim() ?? '';
  if (label === '' || label === member.id || `mem_${label}` === member.id || RAW_ID.test(label)) return null;
  return label;
}

/** The signed-in member's name: the label when it names them, else the GitHub login, else a plain word. */
export function memberDisplayName(member: { id: string; label: string | null } | null, login: string | undefined): string {
  return (member === null ? null : memberLabel(member)) ?? (login !== undefined && login !== '' ? login : 'You');
}
