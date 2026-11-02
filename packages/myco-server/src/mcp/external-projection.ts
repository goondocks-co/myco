const WITHHELD = new Set(['author', 'author_kind', 'authorKind', 'agent_id', 'agentId', 'member_id', 'memberId', 'member_label', 'memberLabel', 'ended_by_label', 'endedByLabel']);
const IDENTITY_FILTERS = ['agent_id', 'author', 'user'] as const;

/** External responses omit identity columns at every nested projection and cross-link. */
export function projectExternal<T>(kind: string, value: T): T {
  if (kind !== 'grant' || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => projectExternal(kind, item)) as T;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !WITHHELD.has(key))
    .map(([key, item]) => [key, key === 'user' ? null : projectExternal(kind, item)])) as T;
}

/** Identity filters cannot act as an oracle for fields withheld from the response. */
export function externalFilter(kind: string, input: Record<string, unknown>, keys: readonly string[] = IDENTITY_FILTERS): boolean {
  return kind === 'grant' && keys.some(key => input[key] !== undefined);
}
