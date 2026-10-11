/** File-only discovery of retained 1.4 capture state. */
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { legacyVaultFiles } from '@myco/member/home-role.js';
import { BACKUP_TABLES } from '@myco/member/legacy-backup.js';
import { defaultMycoHome, resolveHomeDir } from '@myco/paths/home.js';
import { isDaemonUnit, readMycoUnits, unitDirectories } from '@myco/member/legacy-unit-files.js';
import { legacyTargets, scanLegacyRegistrations } from '@myco/member/legacy-registration-files.js';

export interface LegacySources {
  homes: string[];
  vaults: { path: string; size: number; mtimeMs: number; wal: { size: number; mtimeMs: number } | null }[];
  units: { label: string; file: string }[];
  registrations: { agent: string; target: string }[];
  binary: { path: string; version: 'unknown' } | null;
}

export class LegacyMigrationUnreadable extends Error {
  constructor(readonly file: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail.startsWith(`cannot read ${file}:`) ? detail : `cannot read ${file}: ${detail}`, { cause });
  }
}

/** Resolve aliases of existing paths without hiding read failures. */
export function legacyRealpath(file: string): string {
  try { return fs.realpathSync.native(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(file);
    throw error;
  }
}

/** SQLite can retain newly captured rows in the WAL while the database file is unchanged. */
export function legacyVaultStamp(file: string): LegacySources['vaults'][number] {
  const stat = fs.statSync(file);
  fs.accessSync(file, fs.constants.R_OK);
  let wal: LegacySources['vaults'][number]['wal'] = null;
  try {
    const held = fs.statSync(`${file}-wal`);
    if (held.size > 0) wal = { size: held.size, mtimeMs: held.mtimeMs };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { path: legacyRealpath(file), size: stat.size, mtimeMs: stat.mtimeMs, wal };
}

/** Project identities only, read when a vault has no current receipt. */
export function legacyVaultProjectIds(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    const ids = new Set<string>();
    const present = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const table of BACKUP_TABLES) {
      if (!present.has(table)) continue;
      if (!db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((r) => r.name === 'project_id')) continue;
      for (const row of db.query<{ project_id: string }, []>(`SELECT DISTINCT project_id FROM ${table} WHERE project_id IS NOT NULL`).all()) ids.add(row.project_id);
    }
    return [...ids].sort();
  } finally { db.close(); }
}

export function legacySources(home: string, opts: { homeDir?: string; homes?: readonly string[]; folders?: readonly string[]; unitDirs?: ReturnType<typeof unitDirectories> } = {}): LegacySources {
  const homeDir = opts.homeDir ?? resolveHomeDir();
  const homes = [...new Set((opts.homes ?? [home, defaultMycoHome(homeDir)]).map(legacyRealpath))];
  const vaults = [...new Set(homes.flatMap(legacyVaultFiles).map(legacyRealpath))].map(legacyVaultStamp);
  const dirs = opts.unitDirs ?? unitDirectories(process.env, homeDir, process.platform);
  const units = dirs.flatMap(({ dir, scope }) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
      throw new LegacyMigrationUnreadable(dir, error);
    }
    for (const name of names.filter((n) => /^co\.goondocks\.myco.*\.(plist|service)$/.test(n))) {
      const file = path.join(dir, name);
      try { fs.readFileSync(file, 'utf8'); } catch (error) { throw new LegacyMigrationUnreadable(file, error); }
    }
    return readMycoUnits(dir, scope).filter((u) => isDaemonUnit(u) && (u.home === null || homes.includes(legacyRealpath(u.home))));
  });
  for (const { file, location } of legacyTargets(homeDir, opts.folders ?? [])) {
    try {
      if (location.kind === 'skills') fs.readdirSync(file); else fs.readFileSync(file);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new LegacyMigrationUnreadable(file, error);
    }
  }
  const scan = scanLegacyRegistrations({ homeDir, legacyHomes: homes, ownHome: home, folders: opts.folders });
  if (scan.unreadable.length > 0) throw new LegacyMigrationUnreadable(scan.unreadable[0].file, scan.unreadable[0].reason);
  const binaries = homes.map((h) => path.join(h, 'bin', process.platform === 'win32' ? 'myco.exe' : 'myco'));
  const binary = binaries.find((file) => {
    try { return fs.statSync(file).isFile(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  });
  return {
    homes, vaults, units: units.map(({ label, file }) => ({ label, file })),
    registrations: scan.findings.filter((f) => f.verdict === 'legacy').map((f) => ({ agent: f.location.agent, target: f.file })),
    binary: binary === undefined ? null : { path: binary, version: 'unknown' },
  };
}
