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
