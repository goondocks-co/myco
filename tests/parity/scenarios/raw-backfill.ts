import { expect } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, MEMBER_ID, MACHINE_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

export const HISTORICAL_BLOBS = 1_105;
export const HISTORICAL_PLANS = 205;
export const HISTORICAL_EVENTS = 10_000;
export const HISTORICAL_TRANSCRIPTS = 5;
export const BACKFILL_PROJECTS = ['proj_backfill_a', 'proj_backfill_b'] as const;
const PARITY_EVENTS = 2_000;
const MAX_BACKFILL_PASSES = 80;

/** Source rows written without a provenance schema, including retained and mixed transcript segments. */
export function historicalBackfillSql(now: number, member = 'member_backfill', machine = 'machine_backfill', credential = 'credential_backfill', events = HISTORICAL_EVENTS): string[] {
  const [a, b] = BACKFILL_PROJECTS;
  const seq = (count: number) => `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ${count})`;
  const project = `CASE WHEN i % 2 = 0 THEN ${lit(a)} ELSE ${lit(b)} END`;
  const key = `printf('%064x', CAST(i / 2 AS INTEGER))`;
  return [
    `INSERT INTO projects (project_id, name, created_at) VALUES (${lit(a)}, 'backfill a', ${now}), (${lit(b)}, 'backfill b', ${now})`,
    `INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (${lit(member)}, 'historical uploader', ${now}, 'member'), ('member_backfill_other', 'other uploader', ${now}, 'member')`,
    `INSERT OR IGNORE INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(machine)}, ${lit(member)}, ${now}), ('machine_backfill_other', 'member_backfill_other', ${now})`,
    `INSERT OR IGNORE INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, lineage_root, lineage_started_at)
      VALUES (${lit(credential)}, ${lit(member)}, ${lit(machine)}, 'backfill historical digest', 0, 1, 1, 0, ${lit(credential)}, 0),
      ('credential_backfill_other', 'member_backfill_other', 'machine_backfill_other', 'other historical digest', 0, 1, 1, 0, 'credential_backfill_other', 0)`,
    `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES (${lit(a)}, 'backfill_session', ${lit(machine)}, ${lit(credential)}, ${now}, ${now}), (${lit(b)}, 'backfill_session', ${lit(machine)}, ${lit(credential)}, ${now}, ${now})`,
    `${seq(HISTORICAL_BLOBS)} INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
      SELECT ${project}, ${key}, 1, 'text/plain; charset=utf-8', ${lit(credential)}, ${now}, '00000000-0000-4000-8000-000000000001' FROM seq`,
    `INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
      SELECT project_id, 'held-' || key, 'backfill_session', 'held-' || key, key, media_type, size, ${now}, token_id, ${now} FROM blobs WHERE project_id IN (${lit(a)}, ${lit(b)})`,
    `${seq(events)} INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      SELECT ${project}, 'raw-event-' || printf('%05d', i), 'backfill_session', ${lit(credential)}, 'notification', 'cli', json_object('message', 'preserved ' || i), 'historical envelope hash', ${now}, ${now} FROM seq`,
    `${seq(HISTORICAL_PLANS)} INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      SELECT ${project}, 'plan-event-' || printf('%05d', i), 'backfill_session', ${lit(credential)}, 'plan', 'cli', json_object('planKey', 'plan-' || printf('%05d', i), 'blob', ${key}), 'historical plan hash', ${now}, ${now} FROM seq`,
    `${seq(HISTORICAL_PLANS)} INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
      SELECT ${project}, 'plan-' || printf('%05d', i), 'backfill_session', 'plan-event-' || printf('%05d', i), ${lit(machine)}, 'historical spilled plan', NULL, ${key}, ${key}, 'active', ${now}, ${now}, ${lit(credential)}, ${now} FROM seq`,
    `INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, segment_count, first_received_at, last_received_at, token_id)
      VALUES (${lit(a)}, 'retained', 'backfill_session', ${lit(machine)}, 20, 20, ${now}, ${now}, ${lit(credential)}),
      (${lit(a)}, 'mixed', 'backfill_session', ${lit(machine)}, 20, 20, ${now}, ${now}, ${lit(credential)}),
      (${lit(a)}, 'unknown', 'backfill_session', 'missing_machine', 0, 0, ${now}, ${now}, 'missing_credential'),
      (${lit(a)}, 'conflicting', 'backfill_session', ${lit(machine)}, 0, 0, ${now}, ${now}, 'credential_backfill_other'),
      (${lit(b)}, 'known', 'backfill_session', ${lit(machine)}, 1, 1, ${now}, ${now}, ${lit(credential)})`,
    `INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
      VALUES (${lit(a)}, 'retained', 19, 1, ${lit('0'.repeat(64))}, 'retained-segment', ${now}, ${now}, ${lit(credential)}),
      (${lit(a)}, 'mixed', 18, 1, ${lit('0'.repeat(64))}, 'mixed-own-segment', ${now}, ${now}, ${lit(credential)}),
      (${lit(a)}, 'mixed', 19, 1, ${lit('0'.repeat(64))}, 'mixed-other-segment', ${now}, ${now}, 'credential_backfill_other'),
      (${lit(b)}, 'known', 0, 1, ${lit('0'.repeat(64))}, 'known-segment', ${now}, ${now}, ${lit(credential)})`,
    `UPDATE transcripts SET parsed_offset = size WHERE project_id IN (${lit(a)}, ${lit(b)})`,
  ];
}

/** Real native and D1 wake paths finish a large held source fixture without mirroring its event log. */
export const rawBackfillParity: ParityScenario = {
  name: 'raw backfill: bounded historical provenance, retained transcript ownership and completion on native and D1',
  dedicated: { timeoutMs: 360_000 },
  async run(target: ParityTarget) {
    console.info(`[raw-backfill:${target.name}] preparing historical fixture`);
    const writeStatements = async (statements: string[]) => {
      if (target.name === 'cloudflare') await target.sql(statements.join(';\n') + ';');
      else for (const statement of statements) await target.sql(statement);
    };
    const now = Date.now();
    const credential = (await target.sql(`SELECT id FROM member_credentials WHERE token_hash = ${lit(await sha256Hex(target.memberToken))}`))[0]?.id;
    expect(typeof credential).toBe('string');
    const schema = SCHEMA_STEPS.find((step) => step.version === 71)!;
    const names = schema.statements.flatMap((statement) => {
      const match = /CREATE TRIGGER (?:IF NOT EXISTS )?([A-Za-z0-9_]+)/.exec(statement);
      return match === null ? [] : [match[1]];
    });
    const provenanceTriggers = await target.sql(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${names.map(lit).join(',')})`);
    const dropTriggers = provenanceTriggers.map((row) => {
      const name = String(row.name);
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`unexpected fixture trigger ${name}`);
      return `DROP TRIGGER ${name}`;
    });
    await writeStatements(dropTriggers);
    await writeStatements(historicalBackfillSql(now, MEMBER_ID, MACHINE_ID, String(credential), PARITY_EVENTS));
    const sourceRows = async (table: string) => {
      const source: Record<string, unknown>[] = [];
      const pageSize = 250;
      for (let offset = 0; ; offset += pageSize) {
        const page = await target.sql(`SELECT * FROM ${table} WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')}) ORDER BY rowid LIMIT ${pageSize} OFFSET ${offset}`);
        source.push(...page);
        if (page.length < pageSize) break;
      }
      const rows = source.map((row) => {
        if (table !== 'events') return row;
        const { raw_revision: _revision, ...original } = row;
        return original;
      });
      return rows;
    };
    const originals: Array<{ table: string; rows: Record<string, unknown>[]; hash: string }> = [];
    for (const table of ['blobs', 'events', 'transcripts', 'transcript_segments', 'plans']) {
      const rows = await sourceRows(table);
      originals.push({ table, rows, hash: await sha256Hex(JSON.stringify(rows)) });
    }
    const triggerStatements = schema.statements.filter((statement) => statement.startsWith('CREATE TRIGGER'));
    await writeStatements(triggerStatements);
    await target.sql(`UPDATE raw_provenance_backfill SET source = 0, cursor_project = '', cursor_id = '', complete = 0, updated_at = 0 WHERE id = 1`);
    const rows = async () => Number((await target.sql(`SELECT COUNT(*) AS n FROM raw_resources WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')})`))[0]?.n);
    expect(await rows()).toBe(0);
    expect(await target.sql(`SELECT complete FROM raw_provenance_backfill WHERE id = 1`)).toEqual([{ complete: 0 }]);
    const pending = await fetch(`${target.url}/api/projects/${BACKFILL_PROJECTS[0]}/sessions/backfill_session/transcript`, { headers: target.ownerHeaders() });
    expect(pending.status).toBe(404);
    console.info(`[raw-backfill:${target.name}] historical fixture ready; starting bounded wakes`);
    let previous = 0;
    let complete = false;
    for (let pass = 0; pass < MAX_BACKFILL_PASSES; pass += 1) {
      const wake = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(wake.status).toBe(200);
      const wakeBody = await wake.json() as { jobs: Array<{ name: string; changed: number; failed: string | null }> };
      const backfill = wakeBody.jobs.find((job) => job.name === 'raw-provenance-backfill');
      expect(backfill).toBeDefined();
      expect(backfill!.failed).toBeNull();
      expect(backfill!.changed).toBeLessThanOrEqual(100);
      const checkpoint = await target.sql(`SELECT *, (SELECT COUNT(*) FROM raw_resources WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')})) AS raw_rows FROM raw_provenance_backfill WHERE id = 1`);
      const current = Number(checkpoint[0]?.raw_rows);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
      if (pass % 10 === 0) console.info(`[raw-backfill:${target.name}] pass ${pass}; source ${checkpoint[0]?.source}; raw snapshots ${current}`);
      complete = checkpoint[0]?.complete === 1;
      if (complete) break;
    }
    expect(complete).toBe(true);
    expect(await rows()).toBe(HISTORICAL_BLOBS + HISTORICAL_TRANSCRIPTS);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM raw_resources WHERE kind = 'event'`)).toEqual([{ n: 0 }]);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM events WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')})`)).toEqual([{ n: PARITY_EVENTS + HISTORICAL_PLANS }]);
    expect(await target.sql(`SELECT kind, COUNT(*) AS n FROM processed_resources WHERE project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')}) GROUP BY kind ORDER BY kind`)).toEqual([
      { kind: 'attachment', n: HISTORICAL_BLOBS }, { kind: 'plan', n: HISTORICAL_PLANS },
    ]);
    for (const original of originals) {
      const rows = await sourceRows(original.table);
      const changed = rows.findIndex((row, index) => JSON.stringify(row) !== JSON.stringify(original.rows[index]));
      if (changed !== -1) {
        throw new Error(`Backfill changed ${original.table} row ${changed}: ${JSON.stringify({ before: original.rows[changed], after: rows[changed] })}`);
      }
      expect(await sha256Hex(JSON.stringify(rows)), original.table).toBe(original.hash);
    }
    expect(await target.sql(`SELECT resource_id AS transcript_id, owner_member_id FROM raw_resources WHERE kind = 'transcript' AND project_id IN (${BACKFILL_PROJECTS.map(lit).join(',')}) ORDER BY resource_id`)).toEqual([
      { transcript_id: 'conflicting', owner_member_id: null }, { transcript_id: 'known', owner_member_id: MEMBER_ID },
      { transcript_id: 'mixed', owner_member_id: null }, { transcript_id: 'retained', owner_member_id: MEMBER_ID }, { transcript_id: 'unknown', owner_member_id: null },
    ]);
    const admitted = await fetch(`${target.url}/api/projects/${BACKFILL_PROJECTS[0]}/sessions/backfill_session/transcript`, { headers: target.ownerHeaders() });
    expect(admitted.status).toBe(200);
    const body = await admitted.json() as { transcripts: Array<{ transcriptId: string }> };
    expect(body.transcripts.map((row) => row.transcriptId)).toEqual(['retained']);
  },
};
