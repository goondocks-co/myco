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

/**
 * The producer a Myco 1.4 vault import names on every event it sends. A prompt
 * a Deployment holds from this producer is a session whose content came from a
 * vault rather than a transcript, which the import plan never admits a
 * transcript for.
 */
export const LEGACY_IMPORT_ADAPTER = 'legacy-import';
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

/**
 * The dashboard controls an administrator uses to let a machine that already
 * belongs to a member sign in again: People & machines → Add a machine → For,
 * with that member picked. The dashboard renders these words and the member's
 * notices quote them, so the two cannot drift apart.
 */
export const INVITE_CONTROLS = {
  page: 'People & machines',
  invite: 'Invite a teammate',
  button: 'Add a machine',
  field: 'For',
} as const;

/**
 * The one act that restores a machine whose credential the Deployment will no
 * longer renew. The machine's identity stays claimed by its member, so an
 * invitation for a new member is refused (`identity_claimed`); only one for
 * that member signs the machine in again, and its captured backlog is
 * delivered with it.
 */
export const REJOIN_HINT = `ask a Deployment admin for an invitation for your existing member `
  + `(dashboard: ${INVITE_CONTROLS.page} → ${INVITE_CONTROLS.button} → ${INVITE_CONTROLS.field}: <your member>), `
  + 'then run `myco login <link>` with the link it gives; an invitation for a new member is refused on this machine';

/**
 * Why an invitation for a new member is refused on a machine that already
 * joined (#1209). A machine's identity (`machine_id`) is derived from the
 * machine itself, so every home on it signs in with the same identity unless
 * that home holds a `machine_id` file of its own; and the identity stays with
 * the member it first joined as, including after that member is removed. So one
 * machine holds one membership of a Deployment, and nothing moves it to
 * another member.
 */
export const MACHINE_IDENTITY_NOTE = 'A machine belongs to one member of a Deployment: every home on it signs in as the same machine '
  + 'unless that home holds a machine_id file of its own, and it stays that member\'s after the member is removed. '
  + 'Nothing moves a machine to another member';

/** The same fact as an administrator reads it, when removing a member. */
export const MEMBER_KEEPS_MACHINES = 'Their machines stay theirs: none of them can join this Deployment as another member, and none can be moved to one.';

/** The same act as an administrator reads it, for a machine they stopped or whose credential ended. */
export const REJOIN_FOR_ADMIN = `To write again, the machine needs an invitation for its member `
  + `(${INVITE_CONTROLS.button} → ${INVITE_CONTROLS.field}: its member), redeemed with \`myco login <link>\`; `
  + 'an invitation for a new member is refused on that machine.';

/**
 * The path an invite link carries: `<origin>/join#<key>`. The dashboard builds
 * the link from it and `myco login` reads the same shape; the key rides in the
 * fragment, which no browser puts on the wire.
 */
export const JOIN_PATH = '/join';

/**
 * Why a machine's plan folder names too much to watch (#1393), or null when it names one folder: a folder is
 * captured whole, so an entry that is, or resolves to, the filesystem root (`/`), the home (`~`, `~/`) or the
 * project root (`.`) would capture every Markdown file beneath it, and one that climbs with `..` reaches past
 * where it starts. A `~` not followed by `/` names another account's home, and is refused with them.
 */
export function planFolderRefusal(entry: string): string | null {
  const segments = entry.split(/[\\/]+/);
  if (segments.includes('..')) return 'expected each path without a ".." segment';
  if (entry.startsWith('~') && !/^~[\\/]/.test(entry)) return entry === '~' ? 'expected a folder under the home, not the home itself' : 'expected a home path to start with ~/';
  const rooted = entry.startsWith('~') ? 'the home' : /^[\\/]/.test(entry) ? 'the filesystem root' : 'the project root';
  const named = segments.slice(entry.startsWith('~') ? 1 : 0).filter((s) => s !== '' && s !== '.');
  return named.length === 0 ? `expected a folder under ${rooted}, not ${rooted} itself` : null;
}
