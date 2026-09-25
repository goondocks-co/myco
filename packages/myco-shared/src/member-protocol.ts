/** The protocol and project header names used by every member request. */
export const MEMBER_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-myco-protocol';
export const PROJECT_HEADER = 'x-myco-project';

function credentialHeaders(token: string, protocol: number): Record<string, string> {
  return { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(protocol) };
}

/** A project-scoped request always declares both its protocol and project. */
export function memberHeaders(credential: { token: string; projectId: string }, protocol: number = MEMBER_PROTOCOL): Record<string, string> {
  return { ...credentialHeaders(credential.token, protocol), [PROJECT_HEADER]: credential.projectId };
}

/** Deployment-scoped requests carry no project header. */
export function deploymentScopedHeaders(credential: { token: string }, protocol: number = MEMBER_PROTOCOL): Record<string, string> {
  return credentialHeaders(credential.token, protocol);
}

/** The grammar a minted event id matches. A session id is opaque and only length-bounded; it has no grammar. */
export const ID_GRAMMAR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The longest an event or session id may be. */
export const MAX_ID_CHARS = 128;

/** Every event kind a member may ship. */
export const MEMBER_KINDS = [
  'session.start', 'session.end', 'prompt', 'tool.use', 'tool.failure', 'response', 'plan', 'attachment',
  'transcript.segment', 'compaction.pre', 'compaction.post', 'subagent.start', 'subagent.stop',
  'stop.failure', 'task.completed', 'notification', 'error',
] as const;

export type MemberKind = (typeof MEMBER_KINDS)[number];

/** Whether a value names an event kind a member ships. */
export const isMemberKind = (value: unknown): value is MemberKind =>
  typeof value === 'string' && (MEMBER_KINDS as readonly string[]).includes(value);

/**
 * The values a record's enum fields may carry: what a member emits and what a
 * Deployment admits, from one list. A Deployment refuses any other value as
 * `invalid_field`, which a member treats as final for the record, so widening
 * one ships as a member protocol bump.
 */
export const PROMPT_ORIGINS = ['user', 'system', 'agent_dispatch', 'hook_injected', 'unknown'] as const;
export type WirePromptOrigin = (typeof PROMPT_ORIGINS)[number];

export const PLAN_STATUSES = ['active', 'in_progress', 'completed', 'abandoned'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** The channel a plan version arrived through. A row written before the column, or by a member that names none, reads NULL — which means "inferred from the key shape", the honest value rather than a guessed default. */
export const PLAN_SOURCES = ['path', 'tag', 'save'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

/** What a transcript is to its session: the session's own, or a delegated agent's written beside it. */
export const TRANSCRIPT_ROLES = ['primary', 'subagent'] as const;
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

/** The most file paths one tool call records, and the longest one path may be. */
export const MAX_FILES_AFFECTED = 100;
export const MAX_FILE_PATH_CHARS = 1024;

const FILE_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** The file paths a tool input names under its conventional path keys, or undefined when it names none. */
export function filesNamedByToolInput(toolInput: unknown): string[] | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const record = toolInput as Record<string, unknown>;
  const files: string[] = [];
  for (const key of FILE_KEYS) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= MAX_FILE_PATH_CHARS) files.push(v);
  }
  return files.length > 0 ? files.slice(0, MAX_FILES_AFFECTED) : undefined;
}
