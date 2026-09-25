/**
 * The retained verbs a joined project answers as a 2.0 member rather than
 * through the 1.4 local runtime. A leaf, so the dispatcher can ask whether a
 * verb is one without loading what the verbs themselves use
 * (`cli/member-dispatch.ts`).
 */

/** Reads the Deployment answers (`cli/member-reads.ts`). */
export const MEMBER_READ_VERBS = ['search', 'vectors', 'session', 'stats'] as const;
export type MemberReadVerb = (typeof MEMBER_READ_VERBS)[number];

/** The member's own machine: its wiring, its logs, its settings. */
export const MEMBER_MACHINE_VERBS = ['doctor', 'logs', 'config'] as const;

export const MEMBER_VERBS = [...MEMBER_READ_VERBS, ...MEMBER_MACHINE_VERBS] as const;
export type MemberVerb = (typeof MEMBER_VERBS)[number];

export const isMemberReadVerb = (verb: string): verb is MemberReadVerb => (MEMBER_READ_VERBS as readonly string[]).includes(verb);
export const isMemberVerb = (verb: string): verb is MemberVerb => (MEMBER_VERBS as readonly string[]).includes(verb);
