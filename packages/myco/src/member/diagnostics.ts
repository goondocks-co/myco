/**
 * What this machine can say about its own membership, as data.
 *
 * `myco member status` prints this and `myco member export` writes it as JSON, so
 * the two report the same facts. It gathers nothing of its own: the registry, the
 * spool, the refusal log, the offline latch and the no-membership record are the
 * producers.
 *
 * Every field below is selected by name. A value added to any of those records
 * later does not reach a report, and free text never enters one: a refusal keeps
 * its code and drops the server's sentence, a check keeps its status and drops
 * its detail. A code is a term from a closed vocabulary; a sentence can hold a
 * path, a key or a captured body.
 *
 * The refusal list is capped and says when it was cut. The session and project
 * lists are as long as the machine's own state: one entry per spool file and per
 * membership.
 */
import { REGISTRY_VERSION, type RegistryEntry } from './registry.js';
import { getPluginVersion } from '../version.js';
import type { MissingMembershipRecord } from './no-membership.js';
import { MemberSpool, type RefusedEntry } from './spool.js';
import { MEMBER_PROTOCOL, isMemberCode, type MemberCode } from './constants.js';
import { ID_GRAMMAR, MAX_ID_CHARS, isMemberKind } from '@goondocks/myco-shared/member-protocol';

/** An instant a surface can render: finite, and a date. */
const rendersAsInstant = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());

/** How many refusals one report carries, newest last. */
export const MAX_REFUSALS_REPORTED = 50;

export const MEMBER_BUNDLE_VERSION = 1;

/** What a member report never carries, by class. */
export const MEMBER_OMISSIONS: readonly string[] = [
  'credentials — the member token and any join code',
  'event payloads — the body of a spooled record and any staged blob',
  'authored text — prompts, responses, plan contents and transcript contents',
  'free-text detail — a refusal keeps its code and a check its status; neither carries a message',
] as const;

/** The membership behind one project root. */
export interface MembershipFacts {
  registryVersion: number;
  /** The Deployment's origin and path, with any userinfo, query and fragment dropped; null where the stored value is not a URL. */
  serverUrl: string | null;
  projectId: string;
  root: string;
  tokenId: string | null;
  memberId: string | null;
  machineId: string;
  joinedAt: number | null;
  unavailableFields: string[];
  expiresAt: number | null;
  expired: boolean | null;
  refreshAfter: number | null;
  refreshTerminal: boolean | null;
}

export interface SpoolSessionFacts {
  sessionId: string;
  /** Null where the session's own spool file could not be read. */
  unacknowledged: number | null;
  /** False where this session's state could not be read; its acknowledgement is then unknown, not absent. */
  stateReadable: boolean;
  lastAckAt: number | null;
}

export interface SpoolFacts {
  /** False where the spool directory could not be read; its sessions are then unknown, not none. */
  readable: boolean;
  /** False where the directory listing, or any session's state, could not be read; acknowledgements are then unknown. */
  stateReadable: boolean;
  sessionFiles: number;
  /** Null where any session file could not be read. */
  unacknowledgedTotal: number | null;
  /** The newest acknowledgement across the spool, and null while any state is unreadable: a maximum over part of it is not the whole. */
  lastAckAt: number | null;
  /** One entry per spool file this project holds. */
  sessions: SpoolSessionFacts[];
}

/** The offline latch, by its three instants. */
export interface LatchFacts {
  since: number;
  nextProbeAt: number;
  backoffMs: number;
}

/**
 * One refusal, by its named code.
 *
 * `code` is null for a logged code outside the closed vocabulary: the log is
 * JSON on disk, so a code is a string until it is checked, and an unchecked one
 * would put arbitrary text in a report.
 */
export interface RefusalFacts {
  /** The event this refusal names, or null where the log holds no id the grammar admits. */
  eventId: string | null;
  /** The session it names — an opaque identifier — or null where the log holds none a member could have shipped. */
  sessionId: string | null;
  /** Null where the log names no kind a member ships. */
  kind: string | null;
  code: MemberCode | null;
  /** Null where the log holds no instant a reader can date. */
  at: number | null;
}

/** Capture an invocation could not attribute, for one project root. */
export interface MissedCaptureFacts {
  root: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface ProjectDiagnostics {
  membership: MembershipFacts;
  spool: SpoolFacts;
  latch: LatchFacts | null;
  /** False where the latch file could not be used; whether this member is holding off is then unknown, not answered. */
  latchReadable: boolean;
  refusals: {
    /** Whether the log could be read. False leaves every count below at zero without meaning there are none. */
    logReadable: boolean;
    /** How many readable entries the log holds since it was last reset at its cap. */
    loggedSinceLastReset: number;
    /** Whether the log holds more readable entries than this report lists. */
    truncated: boolean;
    /** Lines the log holds that could not be read; a count above zero means the log is damaged, not empty. */
    unreadableLines: number;
    /** Listed entries whose logged code is outside the closed vocabulary; each carries a null code. */
    unknownCodes: number;
    entries: RefusalFacts[];
  };
}

/** A check's verdict without its sentence. */
export interface CheckFacts {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  /** What it failed on, from a closed vocabulary; null where its name is the whole answer. */
  reason: string | null;
  /** The symbiont it names, where it names one. */
  symbiont: string | null;
  /** The configuration scope it read, where it read one. */
  scope: 'global' | 'project' | null;
  /** The project root it read, and null for a check that read no project. */
  root?: string | null;
  fixable: boolean;
  fixId: string | null;
}

/** What the caller asked about, so a report with no membership still says what it looked for. */
export interface SelectionFacts {
  /** The project root asked about; null when the caller asked for every membership. */
  root: string | null;
  scope: 'root' | 'all';
  /** Whether the registry holds a membership for what was asked, and null where it held none and could not be read. */
  membershipPresent: boolean | null;
}

/** What the missed-capture record store could answer for. */
export interface MissedCaptureStoreFacts {
  /** False where the store, or the record asked for, could not be read. */
  readable: boolean;
  /** Record files that are there and unusable. */
  unavailableRecords: number;
}

/** What the registry could answer for. */
export interface RegistryFacts {
  /** False where the registry, or the entry asked for, could not be read. */
  readable: boolean;
  /** Entry files that are there and unusable. */
  unavailableEntries: number;
}

export interface MemberDiagnostics {
  bundle: 'myco.member.diagnostics';
  bundleVersion: number;
  generatedAt: number;
  /** The version this binary was built from. */
  buildVersion: string;
  memberProtocol: number;
  selection: SelectionFacts;
  /** One entry per membership the caller asked about; empty when the registry holds none. */
  projects: ProjectDiagnostics[];
  /** What the registry could answer for the selection above. */
  registry: RegistryFacts;
  /** The roots the caller asked about, and no others. */
  missedCapture: MissedCaptureFacts[];
  /** What the store behind that list could answer for. */
  missedCaptureStore: MissedCaptureStoreFacts;
  /** Null when the caller gathered none; a report says it holds none rather than that none failed. */
  checks: CheckFacts[] | null;
  omissions: readonly string[];
}

/** HTTP routing URL without userinfo, query or fragment; null for an unusable URL. */
function exportedServerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function membershipOf(entry: RegistryEntry, now: number): MembershipFacts {
  const unavailableFields: string[] = [];
  const readField = <T>(name: string, value: unknown, valid: (v: unknown) => v is T, optional = false): T | null => {
    if (optional && value === undefined) return null;
    if (valid(value)) return value;
    unavailableFields.push(name);
    return null;
  };
  const instant = rendersAsInstant;
  const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value !== entry.token;
  const tokenId = readField('tokenId', entry.tokenId, identifier, true);
  const memberId = readField('memberId', entry.memberId, identifier, true);
  const joinedAt = readField('joinedAt', entry.joinedAt, instant);
  const expiresAt = readField('expiresAt', entry.expiresAt, instant, true);
  const refreshAfter = readField('refreshAfter', entry.refreshAfter, instant, true);
  const refreshTerminal = readField('refreshTerminal', entry.refreshTerminal, (v): v is boolean => typeof v === 'boolean', true);
  return {
    registryVersion: entry.version ?? REGISTRY_VERSION,
    serverUrl: exportedServerUrl(entry.serverUrl),
    projectId: entry.projectId,
    root: entry.root,
    tokenId,
    memberId,
    machineId: entry.machineId,
    joinedAt,
    expiresAt,
    expired: unavailableFields.includes('expiresAt') ? null : expiresAt !== null && expiresAt <= now,
    refreshAfter,
    refreshTerminal: unavailableFields.includes('refreshTerminal') ? null : refreshTerminal === true,
    unavailableFields,
  };
}

/**
 * A logged entry as the report carries it.
 *
 * The log is a file on the member's disk, so every field is read against what a
 * member could have shipped and nulled where it is not: an event id matching the
 * id grammar, a session id within the opaque bound ingest accepts, a kind from
 * the shipped vocabulary, a code from the member's own, and an instant a reader
 * can date. The free-text reason is dropped.
 */
function refusalOf(entry: RefusedEntry): RefusalFacts {
  const opaqueId = (value: unknown): string | null =>
    typeof value === 'string' && value !== '' && value.length <= MAX_ID_CHARS ? value : null;
  return {
    eventId: typeof entry.eventId === 'string' && ID_GRAMMAR.test(entry.eventId) ? entry.eventId : null,
    sessionId: opaqueId(entry.sessionId),
    kind: isMemberKind(entry.kind) ? entry.kind : null,
    code: isMemberCode(entry.code) ? entry.code : null,
    at: rendersAsInstant(entry.at) ? entry.at : null,
  };
}



/** Missed-capture counts and times, without the free-text invoker. */
export const missedCaptureOf = (record: MissingMembershipRecord): MissedCaptureFacts =>
  ({ root: record.root, count: record.count, firstAt: record.firstAt, lastAt: record.lastAt });

/** One project's spool, latch and refusal log. */
export function projectDiagnostics(entry: RegistryEntry, mycoHome: string, now: number): ProjectDiagnostics {
  // A report reads the spool where it is; a layout it could not use is a fact to carry, not a directory to make.
  const spool = new MemberSpool(entry.projectId, { mycoHome, initialize: false });
  // Acknowledgement is held in session state, which outlives the spool file a
  // session's records were written to.
  // State is read under the records' own lock, so a layout that blocks it is
  // reported here rather than read as a session never acknowledged.
  const acked = new Map(spool.stateSessionIds().map((sessionId) => [sessionId, spool.readAck(sessionId)] as const));
  const spooled = spool.readSpool();
  // A session the listing named but whose state was never written is readable with nothing acknowledged.
  const ackOf = (sessionId: string) => acked.get(sessionId) ?? { readable: true as const, lastAckAt: null };
  const sessions = spooled.sessions.map(({ sessionId, unacknowledged }) => {
    const read = ackOf(sessionId);
    const at = read.readable ? read.lastAckAt : null;
    return { sessionId, unacknowledged, stateReadable: read.readable, lastAckAt: at !== null && at > 0 ? at : null };
  });
  const stateReadable = spooled.readable && [...acked.values()].every((read) => read.readable);
  let lastAck = 0;
  for (const read of acked.values()) if (read.readable && read.lastAckAt !== null) lastAck = Math.max(lastAck, read.lastAckAt);
  const refused = spool.readRefused();
  const reported = refused.entries.slice(-MAX_REFUSALS_REPORTED).map(refusalOf);
  const latchRead = spool.readLatchResult();
  // A latch whose instants no reader can date is one the report cannot use, and
  // it is no more readable than a file it could not parse.
  const latchUsable = latchRead.readable
    && (latchRead.latch === null || (rendersAsInstant(latchRead.latch.since) && rendersAsInstant(latchRead.latch.nextProbeAt)));
  const latch = latchUsable ? latchRead.latch : null;
  return {
    membership: membershipOf(entry, now),
    spool: {
      readable: spooled.readable,
      stateReadable,
      sessionFiles: sessions.length,
      // Null where the directory, or any session file in it, could not be read: a total over what was readable would read as the whole.
      unacknowledgedTotal: !spooled.readable || sessions.some((session) => session.unacknowledged === null)
        ? null
        : sessions.reduce((total, session) => total + (session.unacknowledged ?? 0), 0),
      lastAckAt: stateReadable && lastAck > 0 ? lastAck : null,
      sessions,
    },
    latch: latch === null ? null : { since: latch.since, nextProbeAt: latch.nextProbeAt, backoffMs: latch.backoffMs },
    latchReadable: latchUsable,
    refusals: {
      logReadable: refused.readable,
      loggedSinceLastReset: refused.entries.length,
      truncated: refused.entries.length > reported.length,
      unreadableLines: refused.unreadableLines,
      unknownCodes: reported.filter((entry) => entry.code === null).length,
      entries: reported,
    },
  };
}

/** True for a held membership, false for confirmed absence, null for an unavailable selection. */
function membershipPresent(held: number, registry: RegistryFacts): boolean | null {
  if (held > 0) return true;
  return registry.readable && registry.unavailableEntries === 0 ? false : null;
}

export function memberDiagnostics(opts: {
  mycoHome: string;
  now: number;
  entries: readonly RegistryEntry[];
  missedCapture: readonly MissingMembershipRecord[];
  selection: { root: string | null; scope: 'root' | 'all' };
  /** What the caller's registry read could answer; a direct caller that omits it reports a registry it read whole. */
  registry?: RegistryFacts;
  /** What the caller's missed-capture read could answer; omitted reports a store read whole. */
  missedCaptureStore?: MissedCaptureStoreFacts;
  checks?: readonly CheckFacts[];
}): MemberDiagnostics {
  const registry: RegistryFacts = opts.registry ?? { readable: true, unavailableEntries: 0 };
  return {
    bundle: 'myco.member.diagnostics',
    bundleVersion: MEMBER_BUNDLE_VERSION,
    generatedAt: opts.now,
    buildVersion: getPluginVersion(),
    memberProtocol: MEMBER_PROTOCOL,
    selection: { root: opts.selection.root, scope: opts.selection.scope, membershipPresent: membershipPresent(opts.entries.length, registry) },
    registry,
    projects: opts.entries.map((entry) => projectDiagnostics(entry, opts.mycoHome, opts.now)),
    missedCapture: opts.missedCapture.map(missedCaptureOf),
    missedCaptureStore: {
      readable: opts.missedCaptureStore?.readable ?? true,
      unavailableRecords: opts.missedCaptureStore?.unavailableRecords ?? 0,
    },
    checks: opts.checks === undefined ? null : [...opts.checks],
    omissions: MEMBER_OMISSIONS,
  };
}
