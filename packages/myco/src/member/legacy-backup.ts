/**
 * A verified copy of a 1.4 vault, taken before a cutover imports from it.
 *
 * The copy is written with `VACUUM INTO` from a read-only handle on the vault,
 * so the vault itself is never opened for writing, and it is a consistent
 * snapshot however the vault's WAL stood. It is kept only once it passes
 * SQLite's integrity check and holds, table by table, the very rows the vault
 * held: the same digest over every row of every table an import reads. The
 * import reads the copy, never the vault.
 */
import { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The tables a copy must hold row for row: the ones an import reads. */
export const BACKUP_TABLES = ['sessions', 'prompt_batches', 'plans', 'spores', 'resolution_events', 'session_tombstones'] as const;

export type TableCounts = Record<string, number>;

/** What a vault holds, as far as an import can tell: rows per table and one digest over them all. */
export interface VaultContent {
  counts: TableCounts;
  digest: string;
}

/**
 * Row counts and a digest of every checked table the database has. Each row
 * is hashed on its own and the table's row hashes are sorted before they are
 * folded in, so the digest names the rows and not the order `VACUUM` left
 * them in.
 */
export function vaultContent(db: Database): VaultContent {
  const present = new Set((db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name));
  const counts: TableCounts = {};
  const whole = crypto.createHash('sha256');
  for (const table of BACKUP_TABLES) {
    if (!present.has(table)) continue;
    const rows: string[] = [];
    for (const row of db.query(`SELECT * FROM ${table}`).values()) {
      rows.push(crypto.createHash('sha256').update(JSON.stringify(row, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v))).digest('hex'));
    }
    rows.sort();
    counts[table] = rows.length;
    whole.update(`${table}\n${rows.join('\n')}\n`);
  }
  return { counts, digest: whole.digest('hex') };
}

/** The vault's own content, read through a read-only handle. */
export function readVaultContent(file: string): VaultContent {
  const db = new Database(file, { readonly: true });
  try { return vaultContent(db); } finally { db.close(); }
}

/** Why a copy does not stand for the vault content `expected`, or null when it does. */
export function copyProblem(copy: string, expected: VaultContent): string | null {
  if (!fs.existsSync(copy)) return 'the copy is missing';
  const db = new Database(copy, { readonly: true });
  try {
    const integrity = db.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') return `the copy fails SQLite's integrity check (${integrity.map((r) => r.integrity_check).join('; ')})`;
    const held = vaultContent(db);
    if (held.digest !== expected.digest) return `the copy holds ${JSON.stringify(held.counts)}, the vault ${JSON.stringify(expected.counts)}${JSON.stringify(held.counts) === JSON.stringify(expected.counts) ? ', with different rows' : ''}`;
    return null;
  } finally {
    db.close();
  }
}

/**
 * Copy `source` to `dest` and verify the copy. Throws, leaving no copy behind,
 * when the copy does not stand for the vault.
 */
export function backupVault(source: string, dest: string): VaultContent {
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists; a backup never overwrites`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new Database(source, { readonly: true });
  let content: VaultContent;
  try {
    content = vaultContent(db);
    db.run('VACUUM INTO ?', [dest]);
  } finally {
    db.close();
  }
  const problem = copyProblem(dest, content);
  if (problem !== null) {
    fs.rmSync(dest, { force: true });
    throw new Error(`the backup of ${source} did not verify: ${problem}`);
  }
  return content;
}
