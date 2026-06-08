/**
 * Backup directory resolution — the single source of truth for WHERE a
 * Grove's backups live.
 *
 * One scheme: default `<groveHome>/backups`; when the Grove sets
 * `backup.dir`, `<expanded backup.dir>/<grove.slug>` so one user-chosen
 * root can host every Grove without colliding `<machine>.sql` files.
 *
 * The grove-tier `backup.dir` is read via `loadGroveConfig(groveId)` — the
 * SAME source `/api/backup/config` displays — so the configured directory
 * is actually honored at create/list/auto-backup/maintenance time. The bug
 * this replaces: every consumer read a boot-time single-Grove `liveConfig`,
 * silently ignoring every non-boot Grove's `backup.dir` and landing backups
 * in `<groveHome>/backups` regardless of configuration.
 */

import os from 'node:os';
import path from 'node:path';
import { loadGroveConfig } from '../config/loader.js';
import { loadGroveRecord } from '../grove/registry.js';
import { resolveGroveDir, resolveMycoHome } from '../grove/paths.js';

export interface BackupLocationOptions {
  /** Override Myco home (tests); production resolves via env/HOME. */
  mycoHome?: string;
}

function expandHome(rawDir: string): string {
  return rawDir.startsWith('~/') ? path.join(os.homedir(), rawDir.slice(2)) : rawDir;
}

/** Grove-home default backup dir — used when `backup.dir` is unset. */
export function defaultGroveBackupDir(groveId: string, mycoHome: string): string {
  return path.resolve(resolveGroveDir(groveId, mycoHome), 'backups');
}

/**
 * Canonical backup directory for a Grove. Honors the grove-tier
 * `backup.dir` (read fresh, per-Grove) and falls back to the Grove-home
 * default.
 */
export function resolveGroveBackupDir(groveId: string, opts: BackupLocationOptions = {}): string {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const configuredDir = loadGroveConfig(groveId, mycoHome).backup.dir;
  if (!configuredDir) return defaultGroveBackupDir(groveId, mycoHome);
  const grove = loadGroveRecord(groveId, mycoHome);
  const slug = grove?.slug ?? groveId;
  return path.join(path.resolve(expandHome(configuredDir)), slug);
}

/**
 * Prior locations where this Grove's whole-Grove dumps may still live, so
 * list/restore/migration can find files written before `backup.dir` was set
 * (or by older code). Excludes the canonical dir itself. Project-scoped
 * `~/myco_backups/<projectSlug>` roots are deliberately NOT included — those
 * dumps are not Grove-restorable and are quarantined by the migration.
 */
export function legacyGroveBackupLocations(groveId: string, opts: BackupLocationOptions = {}): string[] {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const canonical = path.resolve(resolveGroveBackupDir(groveId, { mycoHome }));
  const candidates = [defaultGroveBackupDir(groveId, mycoHome)];
  return candidates.filter((dir) => path.resolve(dir) !== canonical);
}

/**
 * Marker the migration drops in a Grove's canonical dir after relocating
 * legacy backups into it. The next `createGroveBackup` consumes the marker
 * and skips its prune that one cycle, so consolidating two directories'
 * worth of dumps into one can't immediately trip retention into deleting
 * backups that were safe in their own directory.
 */
export function migrationMarkerPath(backupDir: string): string {
  return path.join(backupDir, '.myco-migration-pending');
}
