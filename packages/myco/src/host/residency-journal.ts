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
export const ROUTED_RESIDENCY_PULL_PATH = '/routed-capture/residency-pull';

/**
 * Minimum host protocol version a with-history residency transition requires.
 * The host row-ingest route (T2) ships at HOST_PROTOCOL_VERSION 3; a member
 * whose joined host records an older version refuses the move up front (nothing
 * has been touched yet) rather than pushing to a route the host cannot serve.
 * Declared here — not `constants.ts` — so the client-safe journal module owns
 * the gate without pulling the host-protocol constant surface.
 */
export const RESIDENCY_MIN_HOST_PROTOCOL = 3;

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
export type ResidencyPhase = 'parking' | 'pushing' | 'pulling' | 'applying' | 'rehoming' | 'done';

/**
 * True while capture must DIVERT to the journal's destination tenancy — the
 * data-in-motion window. Excludes `rehoming` (the flip has happened and the
 * local Grove is live, so new capture goes straight there) and `done`. The
 * suppression gate keys off this, NOT mere journal existence, so the terminal
 * sweep can drive its own crash-resume without re-diverting new events.
 */
export function isResidencyDivertActive(phase: ResidencyPhase): boolean {
  return phase === 'parking' || phase === 'pushing' || phase === 'pulling' || phase === 'applying';
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
  /** Absolute path of the project-scoped safety backup, once taken. */
  backup_ref: string | null;
  /** Per-stream resume tokens (sidecar page keys); `'done'` marks a stream drained. */
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
  /**
   * Lines written to the staging files so far, counted after each successful
   * append. The apply reads the staging back and refuses to proceed unless it
   * sees at least this many lines — without it, a staging directory that could
   * not be read enumerates as empty, applies zero rows, and is then deleted,
   * destroying the whole pulled dataset with no error anywhere.
   *
   * At-least-once re-appends inflate this and the files together, so the two
   * stay comparable. A torn trailing line from a crash mid-append is counted in
   * the file but not here (the increment follows the append), which is why the
   * check is "at least", not equality.
   */
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

/** Append a pulled page (`{table, row}` items) to the per-table NDJSON files.
 *  Append-then-advance-cursor is at-least-once; a resumed re-pull re-appends a
 *  page, and the idempotent apply engine makes the duplicate a no-op. */
export function appendResidencyStagingRows(
  projectId: string,
  rows: ReadonlyArray<{ table: string; row: Record<string, unknown> }>,
  teamsHome: string = resolveTeamsHome(),
): number {
  if (!isGroveEraId(projectId, 'project') || rows.length === 0) return 0;
  const dir = residencyStagingDir(projectId, teamsHome);
  fs.mkdirSync(dir, { recursive: true });
  const byTable = new Map<string, string[]>();
  for (const { table, row } of rows) {
    if (!SAFE_STAGING_TABLE.test(table)) continue;
    const lines = byTable.get(table) ?? [];
    lines.push(JSON.stringify(row));
    byTable.set(table, lines);
  }
  let written = 0;
  for (const [table, lines] of byTable) {
    fs.appendFileSync(path.join(dir, `${table}.ndjson`), `${lines.join('\n')}\n`, 'utf-8');
    written += lines.length;
  }
  return written;
}

/**
 * Every table with a staged page file (apply order is the caller's concern).
 *
 * Three-state: an absent directory genuinely means nothing was staged, but an
 * unreadable one must never enumerate as empty — the caller applies what this
 * returns and then deletes the directory.
 */
export function listResidencyStagingTables(
  projectId: string,
  teamsHome: string = resolveTeamsHome(),
): Presence<string[]> {
  const dir = readDirPresence(residencyStagingDir(projectId, teamsHome));
  if (dir.state !== 'present') return dir as Presence<string[]>;
  return present(
    dir.value
      .filter((e) => e.isFile() && e.name.endsWith('.ndjson'))
      .map((e) => e.name.slice(0, -'.ndjson'.length)),
  );
}

/**
 * Read one table's staged rows.
 *
 * `lines` counts every non-empty line the file held, parseable or not, so the
 * caller can compare against the journal's `staged_rows` and detect a file that
 * was silently truncated. A torn trailing line from a crash mid-append is
 * skipped for the rows but still counted here.
 *
 * Three-state for the same reason as the enumerator: the rows this returns are
 * applied and the file is then deleted, so an unreadable file must not read as
 * an empty one.
 */
export function readResidencyStagingRows(
  projectId: string,
  table: string,
  teamsHome: string = resolveTeamsHome(),
): Presence<{ rows: Record<string, unknown>[]; lines: number }> {
  if (!SAFE_STAGING_TABLE.test(table)) return ABSENT;
  const read = readFilePresence(path.join(residencyStagingDir(projectId, teamsHome), `${table}.ndjson`));
  if (read.state !== 'present') return read as Presence<{ rows: Record<string, unknown>[]; lines: number }>;
  const content = read.value;
  let lines = 0;
  const out: Record<string, unknown>[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines += 1;
    try { out.push(JSON.parse(trimmed) as Record<string, unknown>); } catch { /* skip a torn line */ }
  }
  return present({ rows: out, lines });
}

/** Remove a project's staging tree (final detach cleanup). Idempotent. */
export function clearResidencyStaging(projectId: string, teamsHome: string = resolveTeamsHome()): void {
  if (!isGroveEraId(projectId, 'project')) return;
  fs.rmSync(residencyStagingDir(projectId, teamsHome), { recursive: true, force: true });
}
