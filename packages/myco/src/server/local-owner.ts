import { Database } from 'bun:sqlite';
import { SERVER_SCHEMA_VERSION, MEMBER_ID_PREFIX } from '@myco-server-worker/constants.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { LocalVolume } from './local-volume.js';
import { assertRecordServable, LOCAL_SECRET_NAMES, readLocalRecord, readLocalSecrets, type LocalDeploymentPaths } from './local.js';

const FIRST_MEMBER_KEY = 'first_member_setup';
const FIRST_MEMBER_LABEL = 'Deployment administrator';

/** Issues a first administrator link under stopped-volume ownership; retries replace only its pending link. */
export async function setupLocalOwner(paths: LocalDeploymentPaths, native: NativeSqlite) {
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
        const version = await db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first<{ value: string }>();
        if (Number(version?.value) !== SERVER_SCHEMA_VERSION) throw new Error('native schema must match this binary before owner setup');
        const receipt = await db.prepare('SELECT value FROM schema_meta WHERE key = ?').bind(FIRST_MEMBER_KEY).first<{ value: string }>();
        const { results: members } = await db.prepare('SELECT id, role, github_id, revoked_at FROM members LIMIT 2')
          .all<{ id: string; role: string; github_id: string | null; revoked_at: number | null }>();
        const pending = members.length === 1 && members[0].id === receipt?.value
          && members[0].role === 'admin' && members[0].github_id === null && members[0].revoked_at === null;
        if (!pending && (members.length !== 0 || receipt !== null)) {
          throw new Error('this Deployment already has members; use its existing administrator and invitation flow');
        }
        const now = Date.now();
        const memberId = pending ? members[0].id : `${MEMBER_ID_PREFIX}${crypto.randomUUID()}`;
        if (!pending) {
          await ensureMember(db, memberId, now, 'admin', FIRST_MEMBER_LABEL);
          await db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').bind(FIRST_MEMBER_KEY, memberId).run();
        }
        const link = await issueIdentityLinkAuthority(db, memberId, now, { replaceUnspent: true });
        sqlite.exec('COMMIT');
        return { memberId, url: `${origin}/link#${link.key}`, expiresAt: link.expiresAt };
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    } finally { sqlite.close(); }
  });
}
