import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { READ_BEFORE_PIN } from '@myco-server-worker/ingest/prompt-scheme.js';
import { envelopeFor, parseTranscripts, TRANSCRIPT_IDLE_MS } from '@myco-server-worker/ingest/parse.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { BACKUP_FORMAT, BACKUP_TABLES, deploymentId, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import type { DerivedEvent, ParsedLine, ParserInput, ParserState } from '@myco-server-worker/ingest/parsers/index.js';
import { registerBlob, sqliteD1 } from './helpers/d1.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';
import frozen from '../fixtures/record-identity-legacy-vectors.json';

const NOW = Date.parse('2027-01-01');
const LEGACY = 'legacy-session-v1';
const target = { transcriptId: frozen.transcriptId, sessionId: frozen.sessionId };
const records = (agent: string, lines: readonly ParsedLine[], state?: ParserState, terminal?: ParserInput['terminal'], openPromptId?: string) => PARSERS[agent]!.parse({
  ...target, recordScheme: LEGACY, scheme: READ_BEFORE_PIN[agent]!, now: NOW, lines, ...(state ? { state } : {}), ...(terminal ? { terminal } : {}), ...(openPromptId ? { openPromptId } : {}),
});

function fixtureLines(fixture: string): ParsedLine[] {
  let offset = 0;
  return fs.readFileSync(path.join(import.meta.dir, '../fixtures', fixture), 'utf8').trimEnd().split('\n').map(text => {
    const line = { value: JSON.parse(text) as Record<string, unknown>, offset };
    offset += Buffer.byteLength(text) + 1;
    return line;
  });
}
function relevant(events: readonly DerivedEvent[]): DerivedEvent[] {
  return events.filter(event => event.kind === 'response' || event.kind.startsWith('tool.') || event.kind === 'plan');
}
async function identities(events: readonly DerivedEvent[]) {
  return Promise.all(relevant(events).map(async event => ({
    kind: event.kind, rowId: event.payload.responseId ?? event.payload.toolCallId ?? event.payload.planKey,
    eventId: (await envelopeFor(target, event)).eventId, offset: event.offset,
  })));
}
function sorted<T extends { eventId: unknown }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => String(a.eventId).localeCompare(String(b.eventId)));
}
function insert(sqlite: Database, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  sqlite.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row) as never[]);
}
function projected(sqlite: Database) {
  return [
    ...sqlite.query(`SELECT 'response' AS kind, response_id AS rowId, event_id AS eventId FROM responses`).all(),
    ...sqlite.query(`SELECT CASE WHEN success = 1 THEN 'tool.use' ELSE 'tool.failure' END AS kind, tool_call_id AS rowId, event_id AS eventId FROM tool_calls`).all(),
    ...sqlite.query(`SELECT 'plan' AS kind, plan_key AS rowId, event_id AS eventId FROM plans`).all(),
  ].sort((a, b) => String((a as { eventId: string }).eventId).localeCompare(String((b as { eventId: string }).eventId)));
}
async function oldArtifact(sqlite: Database, db: ReturnType<typeof sqliteD1>): Promise<string> {
  const rows = BACKUP_TABLES.flatMap(table => sqlite.query(`SELECT * FROM "${table}"`).all().map(row => ({ t: table, r: row })));
  const counts = Object.fromEntries(BACKUP_TABLES.map(table => [table, rows.filter(row => row.t === table).length]));
  return [{ format: BACKUP_FORMAT, deploymentId: await deploymentId(db), schemaVersion: 92, createdAt: NOW, producer: 'frozen legacy rows', counts }, ...rows].map(row => JSON.stringify(row)).join('\n');
}

describe('frozen parser identity compatibility', () => {
  it('pairs the frozen baseline with exactly the registered parser set', () => {
    expect(Object.keys(frozen.agents).sort()).toEqual(Object.keys(PARSERS).sort());
    expect(frozen.base).toBe('d77f59994');
  });

  for (const [agent, vector] of Object.entries(frozen.agents)) {
    it(`${agent}: preserves frozen logical and event IDs in complete and every checkpoint-split parse`, async () => {
      const lines = fixtureLines(vector.fixture);
      expect<unknown>(await identities(await records(agent, lines))).toEqual(vector.events);
      for (let split = 0; split <= lines.length; split += 1) {
        const state: ParserState = {};
        const first = await records(agent, lines.slice(0, split), state);
        expect(JSON.stringify(state)).toBe(vector.checkpoints[split]!);
        const restored = JSON.parse(JSON.stringify(state)) as ParserState;
        const priorPrompt = first.filter(event => event.kind === 'prompt' && event.opensTurn !== false).at(-1)?.payload.promptId;
        const second = await records(agent, lines.slice(split), restored, 'complete_file', typeof priorPrompt === 'string' ? priorPrompt : undefined);
        expect<unknown>({ split, ids: sorted(await identities([...first, ...second])) }).toEqual({ split, ids: sorted(vector.events) });
      }
    });

    it(`${agent}: retains emitted frozen rows through v92 migration, parse, owner reread and legacy-artifact restore`, async () => {
      const sqlite = new Database(':memory:');
      const fixture = sqliteEnv();
      const restored = sqliteEnv();
      try {
        sqlite.exec('PRAGMA foreign_keys = ON');
        for (const step of SCHEMA_STEPS.filter(step => step.version <= 92)) for (const statement of step.statements) sqlite.exec(statement);
        insert(sqlite, 'projects', { project_id: 'proj_1', name: 'frozen parser identities', created_at: 0 });
        insert(sqlite, 'members', { id: 'mem_machine_1', label: 'machine_1', github_id: '583231', created_at: 0 });
        const db = sqliteD1(sqlite);
        fixture.env.MYCO_DB = db;
        const { tokenId } = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
        const lines = fixtureLines(vector.fixture);
        const events = await records(agent, lines);
        for (const event of events) {
          const result = await ingestEvent(db, { projectId: 'proj_1', machineId: 'machine_1', tokenId, bodyBytes: 100, now: NOW, writeOrigin: 'server' }, await envelopeFor(target, event));
          expect(result).toMatchObject({ persisted: true });
        }
        const bytes = new TextEncoder().encode(fs.readFileSync(path.join(import.meta.dir, '../fixtures', vector.fixture), 'utf8'));
        const key = await sha256HexOf(bytes);
        const objectKey = registerBlob(sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId, receivedAt: NOW });
        await fixture.bucket.put(objectKey, new Blob([bytes]).stream());
        insert(sqlite, 'transcripts', { project_id: 'proj_1', transcript_id: target.transcriptId, session_id: target.sessionId,
          machine_id: 'machine_1', agent, size: bytes.length, segment_count: 1, first_received_at: NOW, last_received_at: NOW,
          token_id: tokenId, role: 'primary', prompt_identity_scheme: READ_BEFORE_PIN[agent]!, parsed_offset: 0 });
        insert(sqlite, 'transcript_segments', { project_id: 'proj_1', transcript_id: target.transcriptId, base_offset: 0,
          length: bytes.length, blob_key: key, event_id: `segment-${agent}`, created_at: NOW, received_at: NOW, token_id: tokenId });
        const expected = sorted(vector.events.map(({ offset: _offset, ...row }) => row));
        expect<unknown>(projected(sqlite)).toEqual(expected);
        const artifact = await oldArtifact(sqlite, db);
        expect(await applySchemaSteps(db)).toEqual([93]);
        expect<unknown>(projected(sqlite)).toEqual(expected);
        expect(sqlite.query('SELECT record_identity_scheme AS pin FROM transcripts').get()).toEqual({ pin: LEGACY });
        await parseTranscripts(fixture.serverEnv, NOW + TRANSCRIPT_IDLE_MS + 1);
        expect<unknown>(projected(sqlite)).toEqual(expected);
        const reread = await worker.fetch(await asOwnerPost(db, '/api/transcripts/reread', { projectId: 'proj_1', sessionId: target.sessionId }), { ...fixture.env, ...OWNER_ENV });
        expect(reread.status).toBe(200);
        await parseTranscripts(fixture.serverEnv, NOW + TRANSCRIPT_IDLE_MS + 2);
        expect<unknown>(projected(sqlite)).toEqual(expected);
        restored.sqlite.query(`UPDATE schema_meta SET value = ? WHERE key = 'deployment_id'`).run(await deploymentId(db));
        restored.env.BUCKET = fixture.bucket;
        for (const row of sqlite.query<Record<string, unknown>, []>('SELECT * FROM blobs').all()) insert(restored.sqlite, 'blobs', row);
        await restoreArtifact(restored.db, { text: artifact, blobs: fixture.bucket, authorization: { kind: 'recovery' }, now: NOW });
        expect<unknown>(projected(restored.sqlite)).toEqual(expected);
        expect(restored.sqlite.query('SELECT record_identity_scheme AS pin FROM transcripts').get()).toEqual({ pin: LEGACY });
        const restoredReread = await worker.fetch(await asOwnerPost(restored.db, '/api/transcripts/reread', { projectId: 'proj_1', sessionId: target.sessionId }), { ...restored.env, ...OWNER_ENV });
        expect(restoredReread.status).toBe(200);
        await parseTranscripts(restored.serverEnv, NOW + TRANSCRIPT_IDLE_MS + 3);
        expect<unknown>(projected(restored.sqlite)).toEqual(expected);
      } finally { sqlite.close(); fixture.sqlite.close(); restored.sqlite.close(); }
    });
  }

  for (const vector of frozen.edges) {
    it(`${vector.fixture}: preserves baseline logical IDs, event IDs and serialized checkpoint bytes at every split`, async () => {
      const lines = fixtureLines(vector.fixture);
      expect<unknown>(await identities(await records(vector.agent, lines))).toEqual(vector.events);
      for (let split = 0; split <= lines.length; split += 1) {
        const state: ParserState = {};
        const first = await records(vector.agent, lines.slice(0, split), state);
        const encoded = JSON.stringify(state);
        expect(encoded).toBe(vector.checkpoints[split]!);
        const priorPrompt = first.filter(event => event.kind === 'prompt' && event.opensTurn !== false).at(-1)?.payload.promptId;
        const second = await records(vector.agent, lines.slice(split), JSON.parse(encoded), 'complete_file', typeof priorPrompt === 'string' ? priorPrompt : undefined);
        expect<unknown>({ split, ids: sorted(await identities([...first, ...second])) }).toEqual({ split, ids: sorted(vector.events) });
      }
    });
  }
});
