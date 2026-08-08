/**
 * One-time backup migration — relocate each Grove's existing whole-Grove
 * dumps into its canonical directory.
 *
 * Why: before `backup.dir` was honored at write time, backups landed in
 * `<groveHome>/backups`. Once the user sets `backup.dir`, the canonical dir
 * moves to `<backup.dir>/<slug>` and the prior dumps would appear to vanish
 * from the UI. This sweep moves them into the canonical dir so list/restore
 * find them where new backups land.
 *
 * Safety contract:
 *  - Never deletes a backup. Files move (rename when same-volume, copy →
 *    fsync → verify → unlink across volumes); an identical copy already in
 *    the canonical dir makes the source redundant and is dropped, a
 *    same-name-different-size collision is kept under a `.migrated-N` suffix.
 *  - Whole-Grove dumps (`scope: all-projects`, or header-less legacy files)
 *    go to the canonical dir. Project-scoped dumps (no longer restorable
 *    Grove-wide) are quarantined under `<canonical>/.legacy-project-scoped/`.
 *  - After moving ≥1 file into a canonical dir, drops a marker so the first
 *    subsequent backup skips its prune (see `migrationMarkerPath`) — the
 *    consolidated set can't trip retention into deleting just-moved backups.
 *  - Idempotent: a second run finds nothing to move.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listGroves, type GroveRecord } from '../grove/registry.js';
import { resolveMycoHome } from '../grove/paths.js';
import {
  resolveGroveBackupDir,
  legacyGroveBackupLocations,
  migrationMarkerPath,
} from './location.js';
import { listBackups, readSnapshotHeader } from './engine.js';

const QUARANTINE_SUBDIR = '.legacy-project-scoped';

export interface GroveMigrationResult {
  grove_id: string;
  grove_slug: string;
  /** Whole-Grove dumps moved into the canonical dir. */
  moved: number;
  /** Project-scoped dumps moved into the quarantine subdir. */
  quarantined: number;
  /** Redundant source files dropped (an identical copy already existed). */
  deduped: number;
}

/** Migrate legacy backups for every Grove this daemon serves. */
export function migrateLegacyBackups(opts: { mycoHome?: string } = {}): GroveMigrationResult[] {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const groves = listGroves(mycoHome);
  return groves.map((grove) => migrateGrove(grove, mycoHome));
}

function migrateGrove(grove: GroveRecord, mycoHome: string): GroveMigrationResult {
  const canonical = resolveGroveBackupDir(grove.id, { mycoHome });
  const canonicalResolved = path.resolve(canonical);
  let moved = 0;
  let quarantined = 0;
  let deduped = 0;

  for (const legacyDir of legacyGroveBackupLocations(grove.id, { mycoHome })) {
    if (path.resolve(legacyDir) === canonicalResolved) continue; // never move onto self
    for (const meta of listBackups(legacyDir)) {
      const src = path.join(legacyDir, meta.file_name);
      const destDir = isProjectScoped(src) ? path.join(canonical, QUARANTINE_SUBDIR) : canonical;
      const outcome = relocate(src, destDir);
      if (outcome === 'deduped') deduped++;
      else if (destDir === canonical) moved++;
      else quarantined++;
    }
  }

  if (moved > 0) {
    try {
      fs.mkdirSync(canonical, { recursive: true });
      fs.writeFileSync(migrationMarkerPath(canonical), 'prune-suppressed\n', 'utf-8');
    } catch {
      // A missing marker only means the next prune runs normally — not fatal.
    }
  }

  return { grove_id: grove.id, grove_slug: grove.slug, moved, quarantined, deduped };
}

/** Whole-Grove dumps have `scope: all-projects` or no scope line (legacy). */
function isProjectScoped(src: string): boolean {
  try {
    return readSnapshotHeader(src).scope?.kind === 'project';
  } catch {
    return false; // unreadable header → treat as whole-Grove, keep it restorable
  }
}

type RelocateOutcome = 'moved' | 'deduped';

function relocate(src: string, destDir: string): RelocateOutcome {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(src);
  let dest = path.join(destDir, base);

  if (fs.existsSync(dest)) {
    if (fs.statSync(dest).size === fs.statSync(src).size) {
      // An identical copy already lives in the destination (e.g. a prior
      // partial run). The source is redundant — drop it, never the dest.
      fs.unlinkSync(src);
      return 'deduped';
    }
    dest = uniqueDest(destDir, base); // same name, different content → keep both
  }

  try {
    fs.renameSync(src, dest); // same-volume fast path: atomic + instant
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Cross-volume (e.g. backup.dir on another mount): copy + fsync + verify
    // + unlink. fsync before unlink so a crash can't lose the only copy.
    fs.copyFileSync(src, dest);
    const fd = fs.openSync(dest, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.statSync(dest).size !== fs.statSync(src).size) {
      throw new Error(`backup migration size mismatch for ${base}`);
    }
    fs.unlinkSync(src);
  }
  return 'moved';
}

function uniqueDest(destDir: string, base: string): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let i = 1;
  let candidate = path.join(destDir, `${stem}.migrated-${i}${ext}`);
  while (fs.existsSync(candidate)) {
    i += 1;
    candidate = path.join(destDir, `${stem}.migrated-${i}${ext}`);
  }
  return candidate;
}
