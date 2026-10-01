/** The protocol and project header names used by every member request. */
export const MEMBER_PROTOCOL = 1;
export const PROTOCOL_HEADER = 'x-myco-protocol';

/**
 * The header a member's turn-end hook sends on its own session's transcript, which the Deployment reads as the end of
 * that session's open turn. No other pass that ships a transcript sends it, and a Deployment that predates it ignores it.
 */
export const TURN_END_HEADER = 'x-myco-turn-end';
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

/**
 * What a Deployment says it can take, beyond the kinds every Deployment of this protocol takes. It names them on every
 * answer it gives an authenticated member, in `FEATURES_HEADER`, as a comma-separated list.
 *
 * A member ships a feature's kind only to a Deployment that names the feature. A Deployment that does not know a kind
 * holds the record, and the drain stops there (`unknown_kind`), so shipping one before the Deployment knows it would
 * hold that session's capture. Advertising lets a kind be added without a protocol bump: no member sends it until its
 * Deployment says it can take it, and a Deployment that takes it refuses nothing it took before.
 */
export const FEATURES_HEADER = 'x-myco-features';
export const MEMBER_FEATURES = ['turn'] as const;
export type MemberFeature = (typeof MEMBER_FEATURES)[number];

/**
 * A session's turn, as the member observed it: `start` when the person's prompt is taken, `end` when the turn-end hook
 * fires. The event's `createdAt` is the instant, on the member's clock, so a turn end shipped late still closes the turn
 * it ended, not the one open when it arrived.
 */
export const TURN_KIND = 'turn';

/** The kind each feature lets a member ship. */
export const FEATURE_KINDS = { turn: TURN_KIND } as const satisfies Readonly<Record<MemberFeature, string>>;
export type FeatureKind = (typeof FEATURE_KINDS)[MemberFeature];

/** Every kind a member's envelope may name: one it ships to any Deployment, or one a Deployment advertises. */
export type WireKind = MemberKind | FeatureKind;
export const TURN_PHASES = ['start', 'end'] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

/** The features a Deployment's answer names; an absent or empty header names none, and an unknown name is ignored. */
export function featuresNamed(header: string | null | undefined): MemberFeature[] {
  if (!header) return [];
  const named = new Set(header.split(',').map((s) => s.trim()));
  return MEMBER_FEATURES.filter((feature) => named.has(feature));
}

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
export const MEMBER_KEEPS_MACHINES = 'Their machines stay theirs: none of them can join this server as another member, and none can be moved to one.';

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

/**
 * Why a capture folder (`capture.auto_join_roots`) names no folder a machine can capture repositories under, or null
 * when it names one. A capture folder starts at the home (`~/`, or `~\` as Windows writes it), at the filesystem root
 * (`/`, or `\\server\share`), or at a drive (`C:\`, `C:/`), and names a folder beneath it: the home, the root or a
 * drive root itself would capture every repository on the machine, and one that climbs with `..` reaches past where it
 * starts. A relative folder names nothing a machine could resolve, nor does a `~` naming another account's home.
 */
export function captureFolderRefusal(entry: string): string | null {
  const segments = entry.split(/[\\/]+/);
  if (segments.includes('..')) return 'expected each path without a ".." segment';
  const home = entry === '~' || /^~[\\/]/.test(entry);
  const drive = /^[A-Za-z]:([\\/]|$)/.test(entry);
  if (!home && !drive && !/^[\\/]/.test(entry)) return 'expected a folder that starts with ~/, / or a drive';
  const rooted = home ? 'the home' : drive ? 'the drive' : 'the filesystem root';
  const named = segments.slice(home || drive ? 1 : 0).filter((s) => s !== '' && s !== '.');
  return named.length === 0 ? `expected a folder under ${rooted}, not ${rooted} itself` : null;
}

/**
 * The kinds of observation a spore records: the types `myco_spores` accepts, the Deployment stores and the dashboard
 * names, in one list.
 */
export const OBSERVATION_TYPES = [
  'gotcha', 'bug_fix', 'decision', 'discovery', 'trade_off', 'cross-cutting', 'wisdom', 'pattern', 'architecture',
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/**
 * How long a machine holds what its agents do in a repository that has not joined (#1547): past it, the held capture
 * is discarded and the Deployment told `expired`.
 */
export const HELD_CAPTURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The same window in whole days, as the words that name it say it. */
export const HELD_CAPTURE_TTL_DAYS = Math.round(HELD_CAPTURE_TTL_MS / (24 * 60 * 60 * 1000));

/**
 * Why a repository a member's machine met is not captured (#1547): outside the folders the machine captures, without
 * a remote, or refused by the Deployment: refused outright, refused while the Deployment keeps project creation with
 * admins, or held by an archived project.
 */
export const UNCAPTURED_REASONS = ['outside_folders', 'no_remote', 'refused', 'auto_create_off', 'archived'] as const;
export type UncapturedReason = (typeof UNCAPTURED_REASONS)[number];
export const isUncapturedReason = (value: unknown): value is UncapturedReason => (UNCAPTURED_REASONS as readonly unknown[]).includes(value);
/** The reasons only the machine can know, and so reports itself; the Deployment records the others as it refuses. */
export const MACHINE_UNCAPTURED_REASONS = ['outside_folders', 'no_remote'] as const;

/** Where a machine asks which project a repository joins: `{ rootKey, label, remote? }`. */
export const RESOLVE_PROJECT_PATH = '/members/projects/resolve';
/** Where a machine reports a repository it will not join on its own: `{ rootKey, label, remote?, reason }`. */
export const REPORT_UNCAPTURED_PATH = '/members/uncaptured';
/**
 * Where a machine says what became of a repository it reported: `{ rootKey, state }`. `connected` forgets the report
 * (a `myco member join` connected it); `left` forgets it and stops the machine being told to connect it (`myco member
 * leave` opted it out); `full` and `expired` record that the machine stopped holding its capture.
 *
 * Every report and resolve also carries `held` (what the machine holds of the repository's capture now) and
 * `sessions` (how many sessions met it after the machine last reported it).
 */
export const UNCAPTURED_STATE_PATH = '/members/uncaptured/state';
/** What a machine holds for a repository it could not capture: its capture, held; held no more past the cap; or discarded with age. */
export const HELD_STATES = ['held', 'full', 'expired'] as const;
export type HeldState = (typeof HELD_STATES)[number];
/** A repository key: the hex digest a machine derives from the repository's path, which never leaves the machine. */
export const ROOT_KEY_PATTERN = /^[0-9a-f]{16,64}$/;

/** The forms a git remote may arrive in; anything else is not a remote. Credentials, port and scheme never reach the name. */
const SCP_FORM = /^(?:(?<user>[^@/\s]+)@)?(?<host>[^:/\s]+):(?<path>[^\s]+)$/;
const URL_SCHEMES = new Set(['ssh:', 'git:', 'http:', 'https:', 'git+ssh:', 'git+https:']);

/** The most a stored remote may carry, bounding a caller that would grow one without limit. */
export const MAX_REMOTE_CHARS = 512;

const tidy = (host: string, rawPath: string): string | null => {
  const path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (path.length === 0) return null;
  const name = `${host.toLowerCase()}/${path}`;
  return name.length <= MAX_REMOTE_CHARS ? name : null;
};

/**
 * One repository's canonical name — `<host>/<path>` — or null when the value is
 * not a git remote at all.
 *
 * Null is what keeps the tenancy argument's two branches disjoint: a value the
 * Project id grammar accepts is an id, a value this accepts is a remote, and
 * anything else resolves to nothing.
 */
export function normalizeRemote(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REMOTE_CHARS) return null;

  if (trimmed.includes('://')) {
    let url: URL;
    try { url = new URL(trimmed); } catch { return null; }
    if (!URL_SCHEMES.has(url.protocol) || url.hostname.length === 0) return null;
    return tidy(url.hostname, url.pathname);
  }

  // A local path is never a remote: a drive letter is no host, and no remote's path holds a backslash.
  if (trimmed.includes('\\')) return null;
  const scp = SCP_FORM.exec(trimmed);
  if (scp?.groups === undefined) return null;
  const { host, path } = scp.groups;
  if (host === undefined || path === undefined || path.startsWith('/') || /^[A-Za-z]$/.test(host)) return null;
  return tidy(host, path);
}

