import { createBackup } from '@myco-server-worker/core/backup.js';
import { advanceRestore, latestRestore } from '@myco-server-worker/core/restore-job.js';
import { bootstrapOwnership } from '@myco-server-worker/db/identity/ownership.js';
import { memoryBlobStore, sqliteEnv } from './fixtures.js';
import { schemaSqlite } from './schema-template.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { captureDocumentTranscript } from './document-stores.js';
import { limits, reply, user } from './document-publication.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { TRANSCRIPT_IDLE_MS } from '@myco-server-worker/ingest/parse.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { archiveRawSources } from '@myco-server-worker/core/raw-archive.js';

/** Fixtures for restore jobs: backups to restore, a destination with an owner, and the tick's walk. */
export const OWNER = 'mem_machine_1';
export const NOW = 1_800_000_000_000;
export type Fixture = ReturnType<typeof sqliteEnv>;

/** A Deployment holding sessions, a run, and insertion-ordered history several chunks long, backed up as one artifact. */
export async function artifactOf(reports: number, events = 0): Promise<string> {
  const source = sqliteEnv();
  try {
    source.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_rs', 'restore', 1)`);
    for (const session of ['sess_a', 'sess_b', 'sess_c']) {
      source.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
        VALUES ('proj_rs', ?, 'm1', 'mt_seed', 1, 1)`, [session]);
    }
    source.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_rs', 'a', 'built-in', 1, 1)`);
    source.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at) VALUES ('proj_rs', 'run_rs', 'agent_rs', 'completed', 1)`);
    const insert = source.sqlite.prepare(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at)
      VALUES ('proj_rs', 'run_rs', 'agent_rs', 'note', ?, 1)`);
    for (let i = 0; i < reports; i++) insert.run(`report ${i}`);
    const event = source.sqlite.prepare(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      VALUES ('proj_rs', ?, 'sess_a', 'mt_seed', 'session_start', 'hook', '{}', ?, 1, 1)`);
    for (let i = 0; i < events; i++) event.run(`ev_${String(i).padStart(5, '0')}`, `h${i}`);
    const backup = await createBackup(source.db, source.bucket, { producer: 'fixture', now: 1 });
    return new TextDecoder().decode(source.bucket.objects.get(backup.key)!.bytes);
  } finally { source.sqlite.close(); }
}

export async function destination(): Promise<Fixture> {
  const target = sqliteEnv();
  await bootstrapOwnership(target.db, OWNER, OWNER, '0', NOW);
  return target;
}

/** What a restore leaves that a reader sees: the restored rows, by key. */
export const restoredRows = (f: Fixture) => ({
  projects: f.sqlite.query(`SELECT project_id, name FROM projects WHERE project_id = 'proj_rs'`).all(),
  sessions: f.sqlite.query(`SELECT session_id FROM sessions WHERE project_id = 'proj_rs' ORDER BY session_id`).all(),
  runs: f.sqlite.query(`SELECT id, status FROM agent_runs WHERE project_id = 'proj_rs'`).all(),
  reports: f.sqlite.query(`SELECT id, summary FROM agent_reports WHERE project_id = 'proj_rs' ORDER BY id`).all(),
  events: f.sqlite.query(`SELECT event_id FROM events WHERE project_id = 'proj_rs' ORDER BY event_id`).all(),
});

/** Walks the running restore to its end the way the tick does, a bounded pass per wake. */
export async function tickUntilEnded(f: Fixture, rows: number, now = NOW): Promise<void> {
  for (let wake = 0; wake < 500; wake++) {
    await advanceRestore(f.serverEnv, now, rows);
    const latest = await latestRestore(f.serverEnv);
    if (latest === null || latest.state !== 'running') return;
  }
  throw new Error('the restore did not end');
}

export const PASS_ROWS = 25;

/** A backup of a Deployment whose member's transcript was published into a session document, with the objects it names. */
export interface DocumentBackup { text: string; blobs: Record<string, unknown>[]; objects: Map<string, { size: number; bytes?: Uint8Array }> }

export async function documentBackup(): Promise<DocumentBackup> {
  const native = schemaSqlite();
  try {
    const db = sqliteRelationalStore(native);
    const bucket = memoryBlobStore();
    native.run(`INSERT INTO projects(project_id,name,created_at) VALUES('project','project',1)`);
    const env = await captureDocumentTranscript(db, bucket, 'portable', 'tx_fedcba9876543210fedcba9876543210', user('portable-turn', 'a kept prompt') + reply('a kept reply'), Date.now(), 0, 'codex');
    for (let pass = 0; pass < 20; pass++) if (!(await publishDocuments(env, Date.now() + TRANSCRIPT_IDLE_MS * 2, limits())).more) break;
    const backup = await createBackup(db, bucket, { producer: 'fixture', now: Date.now() });
    const blobs = native.query<Record<string, unknown>, []>('SELECT * FROM blobs').all();
    const objects = new Map(blobs.map((row) => {
      const key = blobObjectKey(String(row.project_id), String(row.key), row.generation as string | null);
      return [key, bucket.objects.get(key)!] as const;
    }));
    return { text: new TextDecoder().decode(bucket.objects.get(backup.key)!.bytes), blobs, objects };
  } finally { native.close(); }
}

/** A backup of a Deployment whose old events were archived by retention, one bundle per session, with the objects they name. */
export async function bundledBackup(sessions: number): Promise<DocumentBackup> {
  const source = sqliteEnv();
  try {
    source.sqlite.run(`UPDATE raw_archive_state SET phase=2 WHERE id=1`);
    source.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_rs', 'restore', 1)`);
    for (let i = 0; i < sessions; i++) {
      const id = `ev_${String(i).padStart(5, '0')}`;
      source.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
        VALUES ('proj_rs', ?, 'm1', 'mt_seed', 1, 1)`, [`sess_${i}`]);
      source.sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at, payload_bytes, raw_revision)
        VALUES ('proj_rs', ?, ?, 'mt_seed', 'notification', 'cli', ?, ?, 1, ?, 7, 1)`, [id, `sess_${i}`, `{"body":"${id}"}`, id.padEnd(64, '0'), NOW - 120 * 86_400_000]);
    }
    let archived = 0;
    for (let pass = 0; pass < sessions * 4 && archived < sessions; pass++) archived += await archiveRawSources(source.serverEnv, NOW, 90);
    if (archived < sessions) throw new Error(`retention archived ${archived} of ${sessions} events`);
    const backup = await createBackup(source.db, source.bucket, { producer: 'fixture', now: 1 });
    const blobs = source.sqlite.query<Record<string, unknown>, []>('SELECT * FROM blobs').all();
    const objects = new Map(blobs.map((row) => {
      const key = blobObjectKey(String(row.project_id), String(row.key), row.generation as string | null);
      return [key, source.bucket.objects.get(key)!] as const;
    }));
    return { text: new TextDecoder().decode(source.bucket.objects.get(backup.key)!.bytes), blobs, objects };
  } finally { source.sqlite.close(); }
}

/** A destination that already registers the objects the backup names, as a restore requires. */
export async function documentDestination(backup: DocumentBackup): Promise<Fixture> {
  const f = await destination();
  for (const row of backup.blobs) {
    const columns = Object.keys(row);
    f.sqlite.query(`INSERT OR IGNORE INTO blobs(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map((column) => row[column] as string | number | null));
  }
  for (const [key, object] of backup.objects) f.bucket.seed(key, object);
  return f;
}

