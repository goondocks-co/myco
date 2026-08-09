/**
 * Residency-transition journal — the crash-durable record that drives a
 * project's move between local Grove residency and a Team Host (Phase F).
 *
 * One JSON file per project at `<teamsHome>/residency/<projectId>.json`. The
 * `host_id` lives INSIDE the file, never in a path segment: during a transition
 * window there is no attach ref yet, so a client process cannot derive the host
 * from the project id — the journal is the only place the pairing is recorded.
 *
 * This module is deliberately DB-free and daemon-free — pure `fs`, atomic
 * temp+rename writes (the `host/registry.ts` record-write pattern). It is read
 * on the hot path from hook/client processes on every capture request (the
 * suppression gate), the same posture as `resolveAttachForProjectRoot`, so the
 * common no-transition case must short-circuit on a single `existsSync` before
 * touching any per-project file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { HOST_MIN_COMPAT_VERSION } from '../constants.js';
import { isGroveEraId } from '../grove/ids.js';
import { ABSENT, present, readDirPresence, readFilePresence, type Presence } from '@myco/utils/presence.js';
import { resolveTeamsHome } from '../grove/paths.js';

/** Directory under the machine-global team home that holds residency journals. */
export const RESIDENCY_DIRNAME = 'residency';

/**
 * Host route the attach push ships project rows to. Declared here as the single
 * literal both sides build against — the member drain (`host/residency-drain.ts`)
 * POSTs to it, and the host ingest route (T2, `host/routed-residency.ts`) mounts
 * the same string.
 */
export const ROUTED_RESIDENCY_ROWS_PATH = '/routed-capture/residency-rows';

/**
 * Host route the detach pull reads project rows from, page by page. The single
 * literal both sides build against — the member drain (`host/residency-drain.ts`)
 * POSTs to it, and the host pull route (T3, `host/routed-residency.ts`) mounts
 * the same string.
 */
export const ROUTED_DETACH_ARTIFACT_PATH = '/routed-capture/residency-detach-artifact';
export const ROUTED_DETACH_COMPLETE_PATH = '/routed-capture/residency-detach-complete';

/**
 * Minimum host protocol version an ATTACH PUSH requires. A member whose joined
 * host records an older version refuses the move up front (nothing has been
 * touched yet) rather than pushing to a route the host cannot serve. Declared
 * here — not `constants.ts` — so the client-safe journal module owns the gate
 * without pulling the host-protocol constant surface.
 *
 * A host below 5 allow-lists a narrower residency table set than the push sends
 * and answers 400 `unknown table` for the remainder. That fails the push rather
 * than losing data, but it fails midway through a transition, so the gate
 * refuses before the project is parked instead.
 */
export const RESIDENCY_MIN_HOST_PROTOCOL = 5;

/**
 * Minimum host protocol version a DETACH PULL requires. It is `HOST_MIN_COMPAT_VERSION`
 * — the compatibility floor itself — because detach has no floor ABOVE it, and a
 * floor BELOW it is a dead promise.
 *
 * Detach moves the project as one whole-project backup artifact and names no
 * tables, so nothing about the attach push's widened allow-list applies to it:
 * every host a member can still talk to (protocol ≥ `HOST_MIN_COMPAT_VERSION`)
 * serves the artifact route, so there is no additional floor to impose. Detach
 * must never be the direction that strands you — the only escape from a refusal
 * here is `--allow-no-pull`, which abandons the history on the host, and a
 * data-loss fix must not make walking away from your data the supported path.
 *
 * This constant used to sit at 3 ("the version that introduced the artifact
 * routes"), meaning to promise a wider reach than push. But the extra reach was
 * a fiction: the detach precheck admitted a recorded-v3 host, and then the dial
 * hit `hostProtocolCompatible`, which refuses anything below `HOST_MIN_COMPAT_VERSION`
 * (4) — so a v3 host was never actually detachable, it just failed later, at the
 * transport, with a mismatch error instead of the actionable
 * `residency_pull_unavailable` this precheck raises. Pinning the floor to the
 * compat floor refuses a v3 host HERE, up front, and states the honest reachable
 * window: `[HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION]`, the same window
 * every other host call already accepts. The two now cannot drift.
 */
export const RESIDENCY_MIN_HOST_PROTOCOL_PULL = HOST_MIN_COMPAT_VERSION;

/** Which way the project is moving. `attach` — local → host; `detach` — host → local. */
export type ResidencyDirection = 'attach' | 'detach';

/**
 * Where a transition is. Attach walks `parking → pushing → done`; detach walks
 * `pulling → applying → rehoming → done`. A journal that reaches `done` is
 * cleared, so a `done` entry on disk is only ever a momentary pre-clear state.
 *
 * `rehoming` is the detach terminal sweep (move the diverted buffer home, purge
 * the host drain stores). It PERSISTS the journal through the sweep so a crash
 * mid-sweep resumes it, while divert is already OFF (see
 * {@link isResidencyDivertActive}) so no new event lands in the host-Grove
 * buffer after the flip.
 */
/** `pulling`/`applying` are RETIRED phases of the pre-hybrid page-pull detach.
 *  They are kept in the type (and in the divert-active set) so a journal
 *  written by an older dev build keeps routing capture correctly — but the
 *  drain refuses to PROGRESS them, telling the user to cancel and restart the
 *  move. No released binary ever wrote them. */
export type ResidencyPhase = 'parking' | 'pushing' | 'pulling' | 'applying' | 'fetching' | 'restoring' | 'rehoming' | 'done';

/** The phases an abort may cancel — strictly pre-flip on both directions.
 *  The daemon's abort route AND the Team page's Cancel control both read this
 *  (the UI mirrors it in `use-host-membership.ts`, pinned by a parity test),
 *  so a future phase defaults to NOT-cancelable everywhere at once. */
export const ABORTABLE_RESIDENCY_PHASES: ReadonlySet<string> = new Set(['parking', 'pushing', 'fetching', 'pulling']);

/** The retired pre-hybrid detach phases (see {@link ResidencyPhase}). */
export const RETIRED_RESIDENCY_PHASES: ReadonlySet<ResidencyPhase> = new Set(['pulling', 'applying'] as const);

/**
 * True while capture must DIVERT to the journal's destination tenancy — the
 * data-in-motion window. Excludes `rehoming` (the flip has happened and the
 * local Grove is live, so new capture goes straight there) and `done`. The
 * suppression gate keys off this, NOT mere journal existence, so the terminal
 * sweep can drive its own crash-resume without re-diverting new events.
 */
export function isResidencyDivertActive(phase: ResidencyPhase): boolean {
  return phase === 'parking' || phase === 'pushing' || phase === 'pulling' || phase === 'applying'
    || phase === 'fetching' || phase === 'restoring';
}

export interface ResidencyJournal {
  direction: ResidencyDirection;
  phase: ResidencyPhase;
  host_id: string;
  project_id: string;
  /** The tenancy capture DIVERTS to during the window (attach: the host's
   *  served Grove; detach: the host Grove events buffer under until re-homed). */
  divert_grove_id: string;
  /** Attach: the project's own local Grove before the move (the park/restore
   *  anchor). Detach: the data source, which is the host's served Grove. */
  source_grove_id: string;
  /** Detach only: the local Grove the pulled project re-materializes into
   *  (`AttachRef.local_grove_id ?? default grove`). Absent for an attach. */
  target_grove_id?: string;
  project_name: string;
  root: string;
  /** The member's chosen display Grove for the attach ref (E-4 local-view),
   *  persisted so a crash-resumed park recreates the ref with the same choice.
   *  Display-only; absent falls back to the machine default at read time. */
  local_grove_id?: string;
  /** Absolute path of the project-scoped safety backup, once taken. For a
   *  hybrid detach this is the fetched artifact once assembled + verified. */
  backup_ref: string | null;
  /** Hybrid detach transfer resume state: the whole-artifact sha the durable
   *  offset belongs to, and how many bytes of it are already on disk. Cleared
   *  (undefined) when a restart resets the transfer. */
  artifact_sha256?: string;
  artifact_offset?: number;
  /** Per-stream resume tokens (attach sidecar page keys); `'done'` marks a
   *  stream drained. Retired detach journals may carry a legacy `pull` key. */
  cursors: Record<string, string | number>;
  created_at: string;
  updated_at: string;
  /** Attach push: the host has adopted the project name. Adoption rides the
   *  first batch only, so this flips true after that batch's ack. */
  adopted?: boolean;
  /** Last drain failure, for the residency-status/doctor surface (T5). Cleared
   *  when the transition makes forward progress again. */
  last_error?: string;
  last_error_at?: string;
  /** LEGACY (retired page-pull detach): the staged-line tally an old journal
   *  may still carry. Never written by the hybrid; read by nothing. */
  staged_rows?: number;
}

/** Fields a caller supplies to open a journal; timestamps are stamped here. */
export type ResidencyJournalInit = Omit<ResidencyJournal, 'created_at' | 'updated_at'>;

function residencyDir(teamsHome: string = resolveTeamsHome()): string {
  return path.join(teamsHome, RESIDENCY_DIRNAME);
}

/**
 * Absolute path of a project's residency journal.
 *
 * Exported so a transition can hand it to the project write lease as its
 * crash-resumable evidence (write-admission W4): the lease reads the file as
 * DATA rather than importing this module, which keeps `grove/` from
 * depending on `host/`.
 */
export function residencyJournalPath(projectId: string, teamsHome: string = resolveTeamsHome()): string {
  return journalPath(projectId, teamsHome);
}

function journalPath(projectId: string, teamsHome: string = resolveTeamsHome()): string {
  return path.join(residencyDir(teamsHome), `${projectId}.json`);
}

/** A project id must be a well-formed grove-era id before it is joined onto a
 *  path segment — the same structural gate the buffer/registry resolvers use. */
function assertProjectId(projectId: string): void {
  if (!isGroveEraId(projectId, 'project')) {
    throw new Error(`residency journal requires a grove project id (proj_<32 hex>), got ${JSON.stringify(projectId)}.`);
  }
}

/** Cheap short-circuit for the common no-transition case: no residency dir means
 *  no journal for any project, with a single stat and no per-project read. */
export function residencyDirExists(teamsHome: string = resolveTeamsHome()): boolean {
  return fs.existsSync(residencyDir(teamsHome));
}

/** Read one project's journal, or null if none exists / it fails to parse. */
export function readResidencyJournal(
  projectId: string,
  teamsHome: string = resolveTeamsHome(),
): ResidencyJournal | null {
  if (!isGroveEraId(projectId, 'project')) return null;
  if (!residencyDirExists(teamsHome)) return null;
  try {
    return JSON.parse(fs.readFileSync(journalPath(projectId, teamsHome), 'utf-8')) as ResidencyJournal;
  } catch {
    return null;
  }
}

/** Write a journal entry atomically (temp+rename), stamping `updated_at`. */
export function writeResidencyJournal(
  entry: ResidencyJournal,
  teamsHome: string = resolveTeamsHome(),
): ResidencyJournal {
  assertProjectId(entry.project_id);
  const dir = residencyDir(teamsHome);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = journalPath(entry.project_id, teamsHome);
  const toWrite: ResidencyJournal = { ...entry, updated_at: new Date().toISOString() };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
  return toWrite;
}

/** Open a fresh journal for a transition, stamping both timestamps. */
export function startResidencyJournal(
  init: ResidencyJournalInit,
  teamsHome: string = resolveTeamsHome(),
): ResidencyJournal {
  const now = new Date().toISOString();
  return writeResidencyJournal({ ...init, created_at: now, updated_at: now }, teamsHome);
}

/**
 * Advance a journal to `phase`, merging `patch`. Returns the updated journal, or
 * null when no journal exists (a lost/cleared entry — the caller decides whether
 * that is a benign race or an error). `cursors` in the patch is a shallow merge
 * so a single-stream cursor update never clobbers the other stream's token.
 */
export function advanceResidencyPhase(
  projectId: string,
  phase: ResidencyPhase,
  patch: Partial<Omit<ResidencyJournal, 'project_id' | 'created_at'>> = {},
  teamsHome: string = resolveTeamsHome(),
): ResidencyJournal | null {
  const current = readResidencyJournal(projectId, teamsHome);
  if (!current) return null;
  const { cursors: cursorPatch, ...rest } = patch;
  const next: ResidencyJournal = {
    ...current,
    ...rest,
    phase,
    ...(cursorPatch ? { cursors: { ...current.cursors, ...cursorPatch } } : {}),
  };
  return writeResidencyJournal(next, teamsHome);
}

/**
 * Stamp the last drain failure onto a project's journal WITHOUT touching its
 * phase. Reads the journal fresh rather than trusting a caller's snapshot: a
 * failure recorder holding a journal captured before an await — or before a
 * whole drain pass — must never write that snapshot's phase back. A failure
 * during `applying` that rewrote the journal to `pulling` would undo the detach
 * flip's durable record after the flip already ran, and the abort path would
 * then delete the staged rows believing nothing local had changed. No journal
 * on disk → no-op (a concurrent abort or completion cleared it).
 */
export function stampResidencyFailure(
  projectId: string,
  message: string,
  teamsHome: string = resolveTeamsHome(),
): ResidencyJournal | null {
  const current = readResidencyJournal(projectId, teamsHome);
  if (!current) return null;
  return writeResidencyJournal(
    { ...current, last_error: message, last_error_at: new Date().toISOString() },
    teamsHome,
  );
}

/** Clear a previously stamped failure, phase-preserving for the same reason as
 *  {@link stampResidencyFailure}. Returns the journal unchanged when nothing is
 *  stamped; null when no journal exists. */
export function clearResidencyFailure(
  projectId: string,
  teamsHome: string = resolveTeamsHome(),
): ResidencyJournal | null {
  const current = readResidencyJournal(projectId, teamsHome);
  if (!current) return null;
  if (current.last_error === undefined && current.last_error_at === undefined) return current;
  return writeResidencyJournal(
    { ...current, last_error: undefined, last_error_at: undefined },
    teamsHome,
  );
}

/** Remove a project's journal (and any torn temp sibling). Idempotent. */
export function clearResidencyJournal(projectId: string, teamsHome: string = resolveTeamsHome()): void {
  if (!isGroveEraId(projectId, 'project')) return;
  const filePath = journalPath(projectId, teamsHome);
  fs.rmSync(filePath, { force: true });
  fs.rmSync(`${filePath}.tmp`, { force: true });
}

/** Every journal on disk (skips unparseable/wrong-shaped files). */
export function listResidencyJournals(teamsHome: string = resolveTeamsHome()): ResidencyJournal[] {
  const dir = residencyDir(teamsHome);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: ResidencyJournal[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf-8')) as ResidencyJournal;
      if (parsed && typeof parsed.project_id === 'string' && typeof parsed.phase === 'string') out.push(parsed);
    } catch { /* skip a corrupt journal file rather than fail the whole sweep */ }
  }
  return out;
}

/**
 * The cheap suppression gate: is a residency transition underway for this
 * project? Short-circuits on the residency-dir `existsSync` for the common case
 * (no transition anywhere), then checks the one per-project file. A `done`
 * journal (momentary pre-clear) does not count as in-flight.
 */
export function residencyTransitionInFlight(
  projectId: string,
  teamsHome: string = resolveTeamsHome(),
): boolean {
  if (!residencyDirExists(teamsHome)) return false;
  const journal = readResidencyJournal(projectId, teamsHome);
  return journal !== null && journal.phase !== 'done';
}

// ---------------------------------------------------------------------------
// Detach-pull staging — per-table NDJSON page files under
// `<teamsHome>/residency/<projectId>-staging/`, appended as pages are pulled.
// ---------------------------------------------------------------------------

/** A table name is joined onto a staging filename, so it must be a plain
 *  identifier — never a path fragment. The host route allow-lists tables, this
 *  is defense in depth. */
const SAFE_STAGING_TABLE = /^[a-z_][a-z0-9_]*$/;

function residencyStagingDir(projectId: string, teamsHome: string = resolveTeamsHome()): string {
  return path.join(residencyDir(teamsHome), `${projectId}-staging`);
}

/** Remove a project's staging tree (final detach cleanup). Idempotent. */
export function clearResidencyStaging(projectId: string, teamsHome: string = resolveTeamsHome()): void {
  if (!isGroveEraId(projectId, 'project')) return;
  fs.rmSync(residencyStagingDir(projectId, teamsHome), { recursive: true, force: true });
}
