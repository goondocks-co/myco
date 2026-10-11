import { setTimeout as delay } from 'node:timers/promises';
import { Database } from 'bun:sqlite';
import { FIRST_MEMBER_KEY, setupFirstOwner } from '@myco-server-worker/core/first-owner.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { linkedAdmin } from '@myco-server-worker/auth/identity-link.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { LocalVolume } from './local-volume.js';
import { assertRecordServable, LOCAL_SECRET_NAMES, readLocalRecord, readLocalSecrets, type LocalDeploymentPaths } from './local.js';

export interface LocalOwnerLink {
  memberId: string;
  url: string;
  expiresAt: number;
}

/** Issues a first administrator link under stopped-volume ownership; retries replace only its pending link. */
export async function setupLocalOwner(paths: LocalDeploymentPaths, native: NativeSqlite): Promise<LocalOwnerLink> {
  return new LocalVolume(paths).exclusive(async () => {
    const record = readLocalRecord(paths);
    assertRecordServable(record);
    const origin = new URL(record.origin ?? `http://127.0.0.1:${record.port}`).origin;
    const secrets = readLocalSecrets(paths);
    if (LOCAL_SECRET_NAMES.some((name) => !secrets[name])) {
      throw new Error('configure native sign-in with `myco server github-app --target local` before owner setup');
    }
    configureSqliteLibrary(native);
    const sqlite = new Database(paths.databasePath, { readwrite: true, create: false });
    try {
      sqlite.exec('PRAGMA foreign_keys = ON');
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const db = sqliteRelationalStore(sqlite);
        const link = await setupFirstOwner(db, Date.now(), 'native schema must match this binary before owner setup');
        sqlite.exec('COMMIT');
        return { memberId: link.memberId, url: `${origin}/link#${link.key}`, expiresAt: link.expiresAt };
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    } finally { sqlite.close(); }
  });
}

export type OwnerState = 'none' | 'pending-link' | 'linked';

/** The same live linked-admin predicate that ends the server's bootstrap. */
export async function ownerLinked(db: RelationalStore): Promise<boolean> {
  return await db.prepare(`SELECT 1 AS linked FROM members la WHERE ${linkedAdmin('la')} LIMIT 1`).first() !== null;
}

/** Read the first-owner receipt and live administrator state from an already-open volume. */
export function localOwnerState(sqlite: Database): OwnerState {
  if (sqlite.query(`SELECT 1 FROM members la WHERE ${linkedAdmin('la')} LIMIT 1`).get() !== null) return 'linked';
  const pending = sqlite.query(`SELECT 1 FROM members m
    WHERE m.id = (SELECT value FROM schema_meta WHERE key = ?)
      AND m.role = 'admin' AND m.github_id IS NULL AND m.revoked_at IS NULL`).get(FIRST_MEMBER_KEY);
  return pending === null ? 'none' : 'pending-link';
}

/** Shared read ownership coexists with the serving process and refuses volume replacement. */
export async function localOwnerLinked(paths: LocalDeploymentPaths, native?: NativeSqlite): Promise<boolean> {
  return new LocalVolume(paths).reading(async () => {
    configureSqliteLibrary(native);
    const sqlite = new Database(paths.databasePath, { readonly: true });
    try { return await ownerLinked(sqliteRelationalStore(sqlite)); }
    finally { sqlite.close(); }
  });
}

export const OWNER_LINK_POLL_MS = 5_000;

export interface OwnerLinkWaitDeps {
  /** Native callers use localOwnerLinked; hosted callers use their operator store. */
  linked: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Wait for proven linking, expiry, cancellation, or the first operator-store failure. */
export async function waitForOwnerLink(expiresAt: number, deps: OwnerLinkWaitDeps): Promise<'linked' | 'expired'> {
  if (!Number.isFinite(expiresAt)) throw new Error('owner link expiry must be finite');
  const now = deps.now ?? Date.now;
  while (true) {
    deps.signal?.throwIfAborted();
    if (await deps.linked()) return 'linked';
    const remaining = expiresAt - now();
    if (remaining <= 0) return 'expired';
    const ms = Math.min(OWNER_LINK_POLL_MS, remaining);
    if (deps.sleep !== undefined) await deps.sleep(ms);
    else await delay(ms, undefined, { signal: deps.signal });
  }
}

/** The latest unspent first-owner link's expiry, without exposing its bearer key. */
export function localOwnerLinkExpiry(sqlite: Database): number | undefined {
  const row = sqlite.query(`SELECT MAX(expires_at) AS expiresAt FROM identity_link_authorities
    WHERE member_id = (SELECT value FROM schema_meta WHERE key = ?)
      AND used_at IS NULL AND revoked_at IS NULL`).get(FIRST_MEMBER_KEY) as { expiresAt: number | null };
  return row.expiresAt ?? undefined;
}
