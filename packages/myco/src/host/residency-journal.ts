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
 * temp+rename writes (the `host/registry.ts` `upsertHost` pattern). It is read
 * on the hot path from hook/client processes on every capture request (the
 * suppression gate), the same posture as `resolveAttachForProjectRoot`, so the
 * common no-transition case must short-circuit on a single `existsSync` before
 * touching any per-project file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { isGroveEraId } from '../grove/ids.js';
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
 * `pulling → applying → done`. A journal that reaches `done` is cleared, so a
 * `done` entry on disk is only ever a momentary pre-clear state.
 */
export type ResidencyPhase = 'parking' | 'pushing' | 'pulling' | 'applying' | 'done';

export interface ResidencyJournal {
  direction: ResidencyDirection;
  phase: ResidencyPhase;
  host_id: string;
  project_id: string;
  /** The tenancy capture DIVERTS to during the window (attach: the host's
   *  served Grove; detach: the host Grove events buffer under until re-homed). */
  divert_grove_id: string;
  /** The project's own local Grove before the move — the park/restore anchor. */
  source_grove_id: string;
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
}

/** Fields a caller supplies to open a journal; timestamps are stamped here. */
export type ResidencyJournalInit = Omit<ResidencyJournal, 'created_at' | 'updated_at'>;

function residencyDir(teamsHome: string = resolveTeamsHome()): string {
  return path.join(teamsHome, RESIDENCY_DIRNAME);
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
