/** Read-only legacy capture deferral. */
import { legacyVaultFiles } from '@myco/member/home-role.js';
import { defaultMycoHome } from '@myco/paths/home.js';
import fs from 'node:fs';
import path from 'node:path';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { readPrivateJson } from '@myco/member/store.js';

export class LegacyMigrationUnreadable extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(`cannot read ${file}`, { cause });
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readAt<T>(file: string, read: () => T): T {
  try { return read(); } catch (cause) {
    const failed = cause instanceof Error && 'path' in cause && typeof cause.path === 'string' ? cause.path : file;
    throw new LegacyMigrationUnreadable(failed, cause);
  }
}

function backupsAt(home: string): Record<string, unknown> {
  const file = path.join(home, 'member', 'cutover.json');
  const read = readPrivateJson<unknown>(file);
  if (!read.ok) {
    if (read.reason === 'missing') return {};
    throw new LegacyMigrationUnreadable(file, read.detail ?? read.reason);
  }
  if (!record(read.value) || !record(read.value.backups)) throw new LegacyMigrationUnreadable(file, 'invalid backups record');
  return read.value.backups;
}

/** Interim backup-based check; E3's receipt-aware legacyMigrationState replaces this predicate. */
export function legacyMigrationPending(mycoHome: string): boolean {
  const homes = [...new Set([mycoHome, defaultMycoHome()].map((home) => path.resolve(home)))];
  const vaults = homes.flatMap((home) => readAt(home, () => legacyVaultFiles(home)));
  if (vaults.length === 0) return false;
  const backups = homes.map(backupsAt);
  return vaults.some((vault) => {
    const evidence = backups.map((held) => held[vault]).filter(record);
    if (evidence.length === 0) return true;
    const stat = readAt(vault, () => fs.statSync(vault));
    if (evidence.some((held) => held.size === stat.size && held.mtimeMs === stat.mtimeMs)) return false;
    const digests = new Set(evidence.flatMap((held) => typeof held.digest === 'string' ? [held.digest] : []));
    return digests.size === 0 || !digests.has(readAt(vault, () => readVaultContent(vault)).digest);
  });
}
