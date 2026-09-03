import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { linkStatement } from '@myco-server-worker/auth/identity-link.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { serve } from '@myco-server-worker/entry/bun.js';
import { GITHUB_SUB, MACHINE_ID, MEMBER_ID, PROJECT_ID, SESSION_SECRET, lit, memberHeadersFor, volumeSql, type ParityTarget } from '../harness.ts';

/** The shipped self-hosted server, in-process: real entry, real migrations, a temp volume. */
export async function bootSelfhosted(): Promise<ParityTarget> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-parity-'));
  const databasePath = path.join(root, 'myco.sqlite');

  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO members (id, label, created_at, revoked_at) VALUES (?, ?, 0, NULL)`).run(MEMBER_ID, 'parity');
  const db = sqliteRelationalStore(sqlite);
  await linkStatement(db, MEMBER_ID, GITHUB_SUB).run();
  const { token } = await issueMemberToken(db, { memberId: MEMBER_ID, machineId: MACHINE_ID }, Date.now());
  sqlite.close();

  const wrapKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  // The recording launch: the run row takes the recorder's mark and nothing starts, so the queue is proven without a runtime.
  const sql = volumeSql(databasePath);
  const started = await serve({
    harnessLaunch: async (spec) => { await sql(`UPDATE agent_runs SET harness = 'record' WHERE id = ${lit(spec.runId)}`); },
    databasePath,
    blobDir: path.join(root, 'blobs'),
    port: 0,
    bind: 'loopback',
    transport: 'loopback',
    sourceFrom: 'socket',
    wakeLoop: false,
    SESSION_SECRET,
    SECRET_WRAP_KEY: wrapKey,
    GITHUB_CLIENT_ID: 'parity-client',
    GITHUB_CLIENT_SECRET: 'parity-secret',
  });
  const url = `http://127.0.0.1:${started.port}`;
  const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: GITHUB_SUB, login: 'parity', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;

  return {
    name: 'selfhosted',
    url,
    memberToken: token,
    projectId: PROJECT_ID,
    ownerHeaders: () => ({ cookie }),
    memberHeaders: (extra = {}) => memberHeadersFor(token, PROJECT_ID, extra),
    sql,
    stop: async () => {
      await started.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
