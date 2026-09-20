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
import { lastAckAt } from './retention.js';
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
  serverUrl: string;
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
  lastAckAt: number | null;
}

export interface SpoolFacts {
  /** False where the spool directory could not be read; its sessions are then unknown, not none. */
  readable: boolean;
  sessionFiles: number;
  /** Null where any session file could not be read. */
  unacknowledgedTotal: number | null;
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
  eventId: string;
  sessionId: string;
  kind: string;
  code: MemberCode | null;
  at: number;
}

/** Capture an invocation could not attribute, for one project root. */
export interface MissedCaptureFacts {
  root: string;
  count: number;
  firstAt: number;
  lastAt: number;
  lastInvokedBy: string | null;
}

export interface ProjectDiagnostics {
  membership: MembershipFacts;
  spool: SpoolFacts;
  latch: LatchFacts | null;
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
  fixable: boolean;
  fixId: string | null;
}

/** What the caller asked about, so a report with no membership still says what it looked for. */
export interface SelectionFacts {
  /** The project root asked about; null when the caller asked for every membership. */
  root: string | null;
  scope: 'root' | 'all';
  /** Whether the registry holds a membership for what was asked. */
  membershipPresent: boolean;
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
  /** The roots the caller asked about, and no others. */
  missedCapture: MissedCaptureFacts[];
  /** Null when the caller gathered none; a report says it holds none rather than that none failed. */
  checks: CheckFacts[] | null;
  omissions: readonly string[];
}

function membershipOf(entry: RegistryEntry, now: number): MembershipFacts {
  return {
    registryVersion: entry.version ?? REGISTRY_VERSION,
    serverUrl: entry.serverUrl,
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

/** A logged entry's fields, each read as the type the report declares rather than as the cast the log was parsed with. */
function refusalOf(entry: RefusedEntry): RefusalFacts {
  const raw = entry as unknown as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    eventId: text(raw.eventId),
    sessionId: text(raw.sessionId),
    kind: text(raw.kind),
    code: isMemberCode(raw.code) ? raw.code : null,
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
  };
}

export const missedCaptureOf = (record: MissingMembershipRecord): MissedCaptureFacts =>
  ({ root: record.root, count: record.count, firstAt: record.firstAt, lastAt: record.lastAt, lastInvokedBy: record.lastInvokedBy ?? null });

/** One project's spool, latch and refusal log. */
export function projectDiagnostics(entry: RegistryEntry, mycoHome: string, now: number): ProjectDiagnostics {
  // A report reads the spool where it is; a layout it could not use is a fact to carry, not a directory to make.
  const spool = new MemberSpool(entry.projectId, { mycoHome, initialize: false });
  // Acknowledgement is held in session state, which outlives the spool file a
  // session's records were written to.
  const acked = new Map(spool.stateSessionIds().map((sessionId) => [sessionId, lastAckAt(spool, sessionId)]));
  const spooled = spool.readSpool();
  const sessions = spooled.sessions.map(({ sessionId, unacknowledged }) => {
    const at = acked.get(sessionId) ?? 0;
    return { sessionId, unacknowledged, lastAckAt: at > 0 ? at : null };
  });
  let lastAck = 0;
  for (const at of acked.values()) lastAck = Math.max(lastAck, at);
  const refused = spool.readRefused();
  const reported = refused.entries.slice(-MAX_REFUSALS_REPORTED).map(refusalOf);
  const latch = spool.readLatch();
  return {
    membership: membershipOf(entry, now),
    spool: {
      readable: spooled.readable,
      sessionFiles: sessions.length,
      // Null where the directory, or any session file in it, could not be read: a total over what was readable would read as the whole.
      unacknowledgedTotal: !spooled.readable || sessions.some((session) => session.unacknowledged === null)
        ? null
        : sessions.reduce((total, session) => total + (session.unacknowledged ?? 0), 0),
      lastAckAt: lastAck > 0 ? lastAck : null,
      sessions,
    },
    latch: latch === null ? null : { since: latch.since, nextProbeAt: latch.nextProbeAt, backoffMs: latch.backoffMs },
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
export function memberDiagnostics(opts: {
  mycoHome: string;
  now: number;
  entries: readonly RegistryEntry[];
  missedCapture: readonly MissingMembershipRecord[];
  selection: { root: string | null; scope: 'root' | 'all' };
  checks?: readonly CheckFacts[];
}): MemberDiagnostics {
  return {
    bundle: 'myco.member.diagnostics',
    bundleVersion: MEMBER_BUNDLE_VERSION,
    generatedAt: opts.now,
    buildVersion: getPluginVersion(),
    memberProtocol: MEMBER_PROTOCOL,
    selection: { root: opts.selection.root, scope: opts.selection.scope, membershipPresent: opts.entries.length > 0 },
    projects: opts.entries.map((entry) => projectDiagnostics(entry, opts.mycoHome, opts.now)),
    missedCapture: opts.missedCapture.map(missedCaptureOf),
    checks: opts.checks === undefined ? null : [...opts.checks],
    omissions: MEMBER_OMISSIONS,
  };
}
