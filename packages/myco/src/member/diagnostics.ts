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
  joinedAt: number;
  expiresAt: number | null;
  expired: boolean;
  refreshAfter: number | null;
  refreshTerminal: boolean;
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
  /** Null for a refusal that names no event, which a drain raises against an unparsable spool line. */
  eventId: string | null;
  sessionId: string;
  /** Null for a refusal that names no kind, on the same line. */
  kind: string | null;
  code: MemberCode | null;
  at: number;
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
  /** Null when the caller gathered none; a report says it holds none rather than that none failed. */
  checks: CheckFacts[] | null;
  omissions: readonly string[];
}

/**
 * The Deployment a report names: origin and path, with the userinfo, query and
 * fragment a credential rides in dropped.
 *
 * Only `http` and `https` are named. A scheme whose body is its path — `data:`
 * is the plain case — carries whatever it holds through every field cleared
 * here, so a stored value outside the two a Deployment is reached over reports
 * as unknown rather than as itself.
 */
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
  return {
    registryVersion: entry.version ?? REGISTRY_VERSION,
    serverUrl: exportedServerUrl(entry.serverUrl),
    projectId: entry.projectId,
    root: entry.root,
    tokenId: entry.tokenId ?? null,
    memberId: entry.memberId ?? null,
    machineId: entry.machineId,
    joinedAt: entry.joinedAt,
    expiresAt: entry.expiresAt ?? null,
    expired: entry.expiresAt !== undefined && entry.expiresAt <= now,
    refreshAfter: entry.refreshAfter ?? null,
    refreshTerminal: entry.refreshTerminal === true,
  };
}

/** A logged entry as the report carries it: the identifiers the writer left empty read as null, and the free-text reason is dropped. */
function refusalOf(entry: RefusedEntry): RefusalFacts {
  const named = (value: string): string | null => (value === '' ? null : value);
  return {
    eventId: named(entry.eventId),
    sessionId: entry.sessionId,
    kind: named(entry.kind),
    code: isMemberCode(entry.code) ? entry.code : null,
    at: entry.at,
  };
}

/** What a record says, without the free text: the invoker it names is a runtime field and is not a closed vocabulary. */
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
  const latch = latchRead.readable ? latchRead.latch : null;
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
    latchReadable: latchRead.readable,
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

/**
 * The memberships the caller named, with what each spool records.
 *
 * `checks` and `missedCapture` are supplied rather than gathered: the doctor
 * checks live in the CLI tree, and the roots a report may name are the caller's
 * to scope — a report about one project names that project's lost capture and no
 * other root on the machine. An empty `entries` is a report about a root the
 * registry holds no membership for, which `selection` states.
 */
/** True for a membership held, false for one the registry says is not there, and null where it holds none and could not be read. */
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
    checks: opts.checks === undefined ? null : [...opts.checks],
    omissions: MEMBER_OMISSIONS,
  };
}
