/**
 * moveProjectBetweenGroves — relocate a registered project's data and
 * binding from one Grove to another on the same machine.
 *
 * State machine, recorded on a marker file under
 * `<projectVaultDir>/.myco/migration/<moveOpId>.json` so a crash mid-move
 * is recoverable on the next call:
 *
 *   pause → snapshot → snapshot_complete → restored → verified
 *     → committed → cleaned → completed
 *
 * The marker is the source of truth for resumability. A marker for the
 * same (project, from, to) tuple is resumed; any other open marker
 * refuses to proceed. A failure before the commit phase rolls the
 * target back, records the marker as 'failed' (terminal — the next
 * call starts a fresh move op), and releases the source pause.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '@myco/db/client.js';
import { EMBEDDABLE_TABLES } from '@myco/db/queries/embeddings.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { createBackup } from '@myco/backup/engine.js';
import {
  MOVE_COPY_TABLES,
  copyProjectBetweenGroveDbs,
  deleteProjectRowsForMove,
  findOrphanRemappedRows,
  isMissingTableError,
} from './move-copy.js';
import { getMachineId } from '@myco/machine-id.js';
import {
  assertGroveProjectId,
  createGroveBindingId,
  projectScope,
  projectUrlSlug,
} from './ids.js';
import { ensureGroveDatabase } from './database.js';
import { findMarkerFiles, readMarkerJson, writeMarkerJson } from './marker.js';
import {
  resolveBackupsRoot,
  resolveGroveDbPath,
  resolveMycoHome,
  resolveProjectVaultDir,
} from './paths.js';
import {
  deregisterProjectInGrove,
  getRegisteredProjectInGrove,
  loadGroveRecord,
  pauseProject,
  registerProjectInGrove,
  resumeProject,
} from './registry.js';

type MovePhase =
  | 'snapshot'
  | 'snapshot_complete'
  | 'restored'
  | 'verified'
  | 'committed'
  | 'cleaned'
  | 'completed'
  | 'failed';

interface MoveMarker {
  move_op_id: string;
  from_grove_id: string;
  to_grove_id: string;
  project_id: string;
  project_name: string;
  project_root: string;
  started_at: string;
  phase: MovePhase;
  snapshot_path?: string;
  table_counts?: Record<string, number>;
  new_binding_id?: string;
  error?: string;
}

export interface MoveResult {
  from_grove_id: string;
  to_grove_id: string;
  project_id: string;
  snapshot_path: string;
  table_counts: Record<string, number>;
}

export interface MoveProjectOptions {
  /**
   * Override the directory snapshots are written under. Defaults to
   * `~/myco_backups/<projectSlug>/<moveOpId>/`. Tests pass an explicit
   * value so backup files don't escape the test sandbox.
   */
  snapshotsRoot?: string;
}

export function moveProjectBetweenGroves(
  sourceGroveId: string,
  targetGroveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
  options: MoveProjectOptions = {},
): MoveResult {
  if (sourceGroveId === targetGroveId) {
    throw new Error('moveProjectBetweenGroves: source and target Grove ids must differ');
  }

  const sourceGrove = loadGroveRecord(sourceGroveId, mycoHome);
  if (!sourceGrove) throw new Error(`Unknown source Grove: ${sourceGroveId}`);

  const targetGrove = loadGroveRecord(targetGroveId, mycoHome);
  if (!targetGrove) {
    throw new Error(
      `Target Grove ${targetGroveId} is not registered locally. `
      + `Create it explicitly before moving — moves do not auto-provision.`,
    );
  }

  // Source-or-target registry lookup. Past the commit phase the
  // project has already been deregistered from source, so on resume
  // we may have to read it off the target instead.
  const sourceEntry = getRegisteredProjectInGrove(sourceGroveId, projectId, mycoHome);
  const targetEntry = getRegisteredProjectInGrove(targetGroveId, projectId, mycoHome);
  const registryEntry = sourceEntry ?? targetEntry;
  if (!registryEntry) {
    throw new Error(`Project ${projectId} is not registered in Grove ${sourceGroveId}`);
  }

  const projectRoot = registryEntry.root;
  const projectName = registryEntry.name;
  const vaultDir = resolveProjectVaultDir(projectRoot);
  const projectSlug = projectUrlSlug(projectName, projectId);
  const brandedProjectId = assertGroveProjectId(projectId);

  const migrationDir = path.join(vaultDir, 'migration');
  fs.mkdirSync(migrationDir, { recursive: true });

  const existingMarker = findExistingMarkerForProject(migrationDir, projectId);
  const completedMarker = findCompletedMarkerForProject(migrationDir, projectId);

  if (existingMarker && (
    existingMarker.from_grove_id !== sourceGroveId
    || existingMarker.to_grove_id !== targetGroveId
  )) {
    throw new Error(
      `In-progress move marker for ${projectId} targets a different Grove pair `
      + `(${existingMarker.from_grove_id} → ${existingMarker.to_grove_id}); `
      + `cannot resume as ${sourceGroveId} → ${targetGroveId}`,
    );
  }
  const otherMarker = findMarkerForOtherProject(migrationDir, projectId);
  if (otherMarker) {
    throw new Error(
      `In-progress move marker for a different project (${otherMarker.project_id}) `
      + `exists in this vault; complete or remove it before starting another move`,
    );
  }

  // Already-completed move for this from→to pair: idempotent return.
  if (
    !existingMarker
    && completedMarker
    && completedMarker.from_grove_id === sourceGroveId
    && completedMarker.to_grove_id === targetGroveId
    && completedMarker.snapshot_path
    && completedMarker.table_counts
  ) {
    return {
      from_grove_id: sourceGroveId,
      to_grove_id: targetGroveId,
      project_id: projectId,
      snapshot_path: completedMarker.snapshot_path,
      table_counts: completedMarker.table_counts,
    };
  }

  // From this point a non-completed move requires either the source
  // entry to exist, or the target entry to exist (resume after the
  // commit block ran — even partially — already deregistered source).
  // `registryEntry` above already has this OR semantics; the only
  // remaining bug shape is "no entry on either Grove and no resumable
  // marker", which is caught by the registryEntry null check earlier.
  if (!sourceEntry && !targetEntry) {
    throw new Error(`Project ${projectId} is not registered in Grove ${sourceGroveId}`);
  }

  const moveOpId = existingMarker?.move_op_id
    ?? `grove-move-${projectId}-${Date.now()}`;
  const markerPath = path.join(migrationDir, `${moveOpId}.json`);

  let marker: MoveMarker = existingMarker ?? {
    move_op_id: moveOpId,
    from_grove_id: sourceGroveId,
    to_grove_id: targetGroveId,
    project_id: projectId,
    project_name: projectName,
    project_root: projectRoot,
    started_at: new Date().toISOString(),
    phase: 'snapshot',
  };

  // Pause source. `pauseProject` is idempotent for the same owner_op
  // (refreshes `since`, no throw) so a fresh-after-crash resume re-takes
  // its own lock cleanly. A different owner_op on the lock is a real
  // conflict and surfaces.
  //
  // Skipped when the source entry is already gone — that is the resume
  // scenario where the commit block ran register+deregister but did not
  // advance the marker. pauseProject would throw "not registered" in
  // that case, but the pause's purpose (gating writes against the
  // source registry entry) is already met by the entry being absent.
  if (sourceEntry) {
    pauseProject(sourceGroveId, projectId, 'grove-move', moveOpId, mycoHome);
  }

  const sourceDbPath = resolveGroveDbPath(sourceGroveId, mycoHome);
  const targetDbPath = resolveGroveDbPath(targetGroveId, mycoHome);

  // The pause is held from here on. Every exit path below either
  // completes the move (the pause dies with the deregistered source
  // entry) or flows through the catch, which rolls back and releases
  // the pause — a failed move must never leave the source refusing
  // writes.
  try {
    if (!fs.existsSync(markerPath)) writeMarker(markerPath, marker);

    const machineId = getMachineId();
    const snapshotsRoot = resolveBackupsRoot(options.snapshotsRoot);
    const snapshotDir = path.join(snapshotsRoot, projectSlug, moveOpId);
    fs.mkdirSync(snapshotDir, { recursive: true });

    if (orderOf(marker.phase) <= orderOf('snapshot')) {
      const snapshotPath = withDb(sourceDbPath, (sourceDb) => {
        return createBackup(
          sourceDb,
          snapshotDir,
          machineId,
          projectScope(brandedProjectId),
          projectSlug,
        );
      });
      marker = { ...marker, phase: 'snapshot_complete', snapshot_path: snapshotPath };
      writeMarker(markerPath, marker);
    }

    const snapshotPath = marker.snapshot_path;
    if (!snapshotPath) {
      throw new Error('move marker advanced past snapshot but recorded no snapshot_path');
    }

    if (orderOf(marker.phase) <= orderOf('snapshot_complete')) {
      // Target DB may be uninitialized (Grove registered but never
      // activated). `openDatabase` only creates an empty file; the copy
      // needs the schema present before its INSERT statements run.
      ensureGroveDatabase(targetGroveId, mycoHome);
      // Rekey copy straight from the live source DB — the snapshot taken
      // above is a recovery artifact, not the transfer medium. Integer
      // ids are reallocated in the target so a non-empty target Grove
      // cannot collide with (and silently swallow) the moved rows.
      withDbs(sourceDbPath, targetDbPath, (sourceDb, targetDb) => {
        copyAgents(sourceDb, targetDb);
        copyProjectBetweenGroveDbs(sourceDb, targetDb, projectId);
        resetTargetEmbeddingFlags(targetDb, projectId);
      });
      marker = { ...marker, phase: 'restored' };
      writeMarker(markerPath, marker);
    }

    let tableCounts: Record<string, number> = marker.table_counts ?? {};

    if (orderOf(marker.phase) <= orderOf('restored')) {
      const sourceCounts = withDb(sourceDbPath, (sourceDb) =>
        countProjectRows(sourceDb, projectId),
      );
      const targetCounts = withDb(targetDbPath, (targetDb) =>
        countProjectRows(targetDb, projectId),
      );

      const mismatches: string[] = [];
      for (const table of MOVE_COPY_TABLES) {
        const src = sourceCounts[table] ?? 0;
        const tgt = targetCounts[table] ?? 0;
        if (src !== tgt) {
          mismatches.push(`${table}: source=${src}, target=${tgt}`);
        }
      }
      if (mismatches.length > 0) {
        throw new Error(
          `move verification failed for project ${projectId}: ${mismatches.join('; ')}`,
        );
      }

      // Remapped foreign keys must resolve to parents of the moved
      // project. Structurally guaranteed by the rekey copy; checked
      // anyway because a violation here means cross-project corruption.
      const orphans = withDb(targetDbPath, (targetDb) =>
        findOrphanRemappedRows(targetDb, projectId),
      );
      if (orphans.length > 0) {
        throw new Error(
          `move verification failed for project ${projectId}: orphaned rows after rekey: `
          + orphans.join('; '),
        );
      }

      // TEXT foreign keys are copied verbatim (only integer ids are
      // rekeyed), so a source row pointing at another project's parent —
      // e.g. spores.session_id at a sibling project's session — arrives
      // dangling, and count-compare cannot see it. The copy runs with
      // foreign keys deferred; this is where they are enforced. Any
      // violation fails the move before commit, including pre-existing
      // ones in other projects' rows — a target with broken references
      // must surface, not absorb more data.
      const fkViolations = withDb(targetDbPath, (targetDb) =>
        targetDb.prepare('PRAGMA foreign_key_check').all() as Array<{
          table: string;
          rowid: number | bigint | null;
          parent: string;
          fkid: number;
        }>,
      );
      if (fkViolations.length > 0) {
        const listed = fkViolations.slice(0, 20)
          .map((v) => `${v.table}(rowid=${v.rowid}) -> ${v.parent}`)
          .join('; ');
        throw new Error(
          `move verification failed for project ${projectId}: ${fkViolations.length} foreign key `
          + `violation(s) in target after copy: ${listed}`,
        );
      }

      tableCounts = {};
      for (const [table, count] of Object.entries(sourceCounts)) {
        if (count > 0) tableCounts[table] = count;
      }

      marker = { ...marker, phase: 'verified', table_counts: tableCounts };
      writeMarker(markerPath, marker);
    }

    if (orderOf(marker.phase) <= orderOf('verified')) {
      const newBindingId = marker.new_binding_id ?? createGroveBindingId();
      // registerProjectInGrove merges with any existing entry (preserves
      // created_at, refreshes updated_at), so a resume after a partial
      // commit is idempotent on the target side.
      registerProjectInGrove(targetGroveId, {
        projectId,
        projectName,
        projectRoot,
        bindingId: newBindingId,
      }, mycoHome);
      // force: idempotent on resume after a partial commit
      deregisterProjectInGrove(sourceGroveId, projectId, mycoHome, { force: true });
      // Move commit: atomic write of both manifests + gitignore refresh
      // via ProjectVault. The new Grove identity carries the freshly
      // minted binding_id (newBindingId) generated for this move.
      new ProjectVault(projectRoot).writeIdentity({
        manifest: {
          project: { id: projectId, name: projectName },
          grove: {
            id: targetGroveId,
            slug: targetGrove.slug,
            name: targetGrove.name,
            mode: 'local',
          },
        },
        localManifest: {
          grove_binding: { binding_id: newBindingId, mode: 'local' },
        },
      });
      marker = { ...marker, phase: 'committed', new_binding_id: newBindingId };
      writeMarker(markerPath, marker);
    }

    if (orderOf(marker.phase) <= orderOf('committed')) {
      // Source cleanup deletes the MOVED project id only. Rows under
      // sibling legacy project ids sharing the same project_root were
      // never copied to the target, so deleting them here would be
      // unrecoverable data loss — they stay in the source Grove.
      withDb(sourceDbPath, (sourceDb) => {
        deleteProjectRowsForMove(sourceDb, projectId);
      });
      marker = { ...marker, phase: 'cleaned' };
      writeMarker(markerPath, marker);
    }

    if (orderOf(marker.phase) <= orderOf('cleaned')) {
      // Pause was on source's projects.toml entry; deregister already
      // dropped the entry. resumeProject on target is a no-op-on-unpaused
      // path, included for symmetry so future ops see a clean slate.
      resumeProject(targetGroveId, projectId, moveOpId, mycoHome);
      marker = { ...marker, phase: 'completed' };
      writeMarker(markerPath, marker);
    }

    return {
      from_grove_id: sourceGroveId,
      to_grove_id: targetGroveId,
      project_id: projectId,
      snapshot_path: snapshotPath,
      table_counts: marker.table_counts ?? tableCounts,
    };
  } catch (err) {
    handleMoveFailure({
      marker,
      markerPath,
      targetDbPath,
      sourceGroveId,
      projectId,
      moveOpId,
      mycoHome,
      cause: err,
    });
    throw err;
  }
}

interface MoveFailureContext {
  marker: MoveMarker;
  markerPath: string;
  targetDbPath: string;
  sourceGroveId: string;
  projectId: string;
  moveOpId: string;
  mycoHome: string;
  cause: unknown;
}

/**
 * Failure path for a move that threw mid-flight.
 *
 * Before the commit phase the target is not yet authoritative: wipe the
 * moved project's rows from it and record the marker as 'failed' so the
 * next call starts a fresh move op. From 'committed' onward the target
 * owns the data — the marker is left resumable and nothing is wiped.
 * The source pause is released on every failure; rollback steps are
 * best-effort so the original error always propagates.
 */
function handleMoveFailure(ctx: MoveFailureContext): void {
  if (orderOf(ctx.marker.phase) < orderOf('committed')) {
    try {
      withDb(ctx.targetDbPath, (targetDb) =>
        deleteProjectRowsForMove(targetDb, ctx.projectId),
      );
    } catch {
      // Target wipe is best-effort: the wipe-before-copy at the start of
      // the next move's transfer clears any rows left behind here.
    }
    try {
      writeMarker(ctx.markerPath, {
        ...ctx.marker,
        phase: 'failed',
        error: ctx.cause instanceof Error ? ctx.cause.message : String(ctx.cause),
      });
    } catch {
      // A stuck non-failed marker resumes at its recorded phase, which
      // re-runs the (re-entrant) copy rather than corrupting anything.
    }
  }
  try {
    resumeProject(ctx.sourceGroveId, ctx.projectId, ctx.moveOpId, ctx.mycoHome);
  } catch {
    // No-op when the source entry is already deregistered; an owner
    // conflict cannot mask the original failure.
  }
}

const PHASE_ORDER: MovePhase[] = [
  'snapshot',
  'snapshot_complete',
  'restored',
  'verified',
  'committed',
  'cleaned',
  'completed',
];

/**
 * Phases a marker may legitimately record. 'failed' is terminal and
 * deliberately outside PHASE_ORDER — it never participates in resume
 * ordering; both terminal phases mean "this op is over".
 */
const TERMINAL_PHASES = new Set<MovePhase>(['completed', 'failed']);
const VALID_MARKER_PHASES = new Set<MovePhase>([...PHASE_ORDER, 'failed']);

function orderOf(phase: MovePhase): number {
  return PHASE_ORDER.indexOf(phase);
}

function writeMarker(markerPath: string, marker: MoveMarker): void {
  writeMarkerJson(markerPath, marker);
}

function validateMarker(raw: unknown): MoveMarker | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<MoveMarker>;
  if (
    typeof parsed.move_op_id !== 'string'
    || typeof parsed.from_grove_id !== 'string'
    || typeof parsed.to_grove_id !== 'string'
    || typeof parsed.project_id !== 'string'
    || typeof parsed.started_at !== 'string'
    || typeof parsed.phase !== 'string'
    || !VALID_MARKER_PHASES.has(parsed.phase as MovePhase)
  ) {
    return null;
  }
  return {
    move_op_id: parsed.move_op_id,
    from_grove_id: parsed.from_grove_id,
    to_grove_id: parsed.to_grove_id,
    project_id: parsed.project_id,
    project_name: typeof parsed.project_name === 'string' ? parsed.project_name : '',
    project_root: typeof parsed.project_root === 'string' ? parsed.project_root : '',
    started_at: parsed.started_at,
    phase: parsed.phase as MovePhase,
    ...(typeof parsed.snapshot_path === 'string' ? { snapshot_path: parsed.snapshot_path } : {}),
    ...(parsed.table_counts ? { table_counts: parsed.table_counts as Record<string, number> } : {}),
    ...(typeof parsed.new_binding_id === 'string' ? { new_binding_id: parsed.new_binding_id } : {}),
    ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
  };
}

function readMarker(markerPath: string): MoveMarker | null {
  return readMarkerJson<MoveMarker>(markerPath, validateMarker);
}

/**
 * Find a resumable (non-terminal) marker for the project. A 'failed'
 * marker is terminal: the failed op already rolled the target back and
 * released the pause, so the next call must start a fresh move op
 * rather than resume at the failed op's recorded phase.
 */
function findExistingMarkerForProject(migrationDir: string, projectId: string): MoveMarker | null {
  for (const full of findMarkerFiles(migrationDir, () => true)) {
    const parsed = readMarker(full);
    if (parsed && parsed.project_id === projectId && !TERMINAL_PHASES.has(parsed.phase)) {
      return parsed;
    }
  }
  return null;
}

function findCompletedMarkerForProject(migrationDir: string, projectId: string): MoveMarker | null {
  let latest: MoveMarker | null = null;
  let latestStarted = '';
  for (const full of findMarkerFiles(migrationDir, () => true)) {
    const parsed = readMarker(full);
    if (!parsed || parsed.project_id !== projectId) continue;
    if (parsed.phase !== 'completed') continue;
    if (parsed.started_at > latestStarted) {
      latest = parsed;
      latestStarted = parsed.started_at;
    }
  }
  return latest;
}

function findMarkerForOtherProject(migrationDir: string, projectId: string): MoveMarker | null {
  for (const full of findMarkerFiles(migrationDir, () => true)) {
    const parsed = readMarker(full);
    if (parsed && parsed.project_id !== projectId && !TERMINAL_PHASES.has(parsed.phase)) {
      return parsed;
    }
  }
  return null;
}

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    // Move snapshot/restore/verify all run against an existing schema.
    // We open with a dedicated connection so the daemon's process-wide
    // singleton (if active in the same process) is unaffected.
    return fn(db);
  } finally {
    db.close();
  }
}

function withDbs<T>(
  firstDbPath: string,
  secondDbPath: string,
  fn: (firstDb: Database, secondDb: Database) => T,
): T {
  fs.mkdirSync(path.dirname(firstDbPath), { recursive: true });
  fs.mkdirSync(path.dirname(secondDbPath), { recursive: true });
  const firstDb = openDatabase(firstDbPath);
  const secondDb = openDatabase(secondDbPath);
  try {
    return fn(firstDb, secondDb);
  } finally {
    secondDb.close();
    firstDb.close();
  }
}

function copyAgents(sourceDb: Database, targetDb: Database): void {
  const agents = sourceDb.prepare(
    `SELECT
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     FROM agents
     ORDER BY created_at ASC, id ASC`,
  ).all() as Array<Record<string, unknown>>;
  if (agents.length === 0) return;

  const insert = targetDb.prepare(
    `INSERT OR IGNORE INTO agents (
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?
     )`,
  );

  const tx = targetDb.transaction(() => {
    for (const row of agents) {
      insert.run(
        row.id,
        row.name,
        row.provider,
        row.model,
        row.system_prompt_hash,
        row.config,
        row.source ?? 'built-in',
        row.system_prompt,
        row.max_turns,
        row.timeout_seconds,
        row.tool_access,
        row.enabled ?? 1,
        row.created_at,
        row.updated_at,
      );
    }
  });
  tx();
}

function countProjectRows(db: Database, projectId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of MOVE_COPY_TABLES) {
    try {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
      ).get(projectId) as { n: number } | undefined;
      counts[table] = row?.n ?? 0;
    } catch (err) {
      // A missing table counts as zero rows. Any other error must fail
      // the move — the same error swallowed on BOTH sides would let a
      // skipped table verify as 0 == 0 and cleanup delete the only copy.
      if (!isMissingTableError(err)) {
        throw new Error(
          `failed to count ${table} rows for project ${projectId}: `
          + (err instanceof Error ? err.message : String(err)),
        );
      }
      counts[table] = 0;
    }
  }
  return counts;
}

function resetTargetEmbeddingFlags(db: Database, projectId: string): void {
  const tx = db.transaction(() => {
    for (const table of EMBEDDABLE_TABLES) {
      try {
        db.prepare(`UPDATE ${table} SET embedded = 0 WHERE project_id = ?`).run(projectId);
      } catch {
        // Older schemas may not have every embeddable table; skip.
      }
    }
  });
  tx();
}

