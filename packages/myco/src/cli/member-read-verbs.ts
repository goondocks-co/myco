/**
 * The retained read verbs a joined project answers from its Deployment. A
 * leaf, so the dispatcher can ask whether a verb is one without loading the
 * MCP client the verbs themselves use (`cli/member-reads.ts`).
 */
export const MEMBER_READ_VERBS = ['search', 'vectors', 'session', 'stats'] as const;
export type MemberReadVerb = (typeof MEMBER_READ_VERBS)[number];

export const isMemberReadVerb = (verb: string): verb is MemberReadVerb => (MEMBER_READ_VERBS as readonly string[]).includes(verb);
