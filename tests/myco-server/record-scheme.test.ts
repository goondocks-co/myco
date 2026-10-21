import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { BACKUP_FORMAT, deploymentId, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { admittedRecordScheme, restoreRecordSchemeDecisions } from '@myco-server-worker/ingest/record-scheme.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { registerBlob, sqliteD1 } from './helpers/d1.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const LEGACY = 'legacy-session-v1';
const SOURCE = 'source-record-v1';
const transcript = (id: string, pin?: unknown) => ({
  project_id: 'proj_1', transcript_id: id, session_id: 'record-scheme-session', machine_id: 'machine_1', agent: 'cursor',
  size: 0, segment_count: 0, first_received_at: 1, last_received_at: 1, token_id: 'token_1', role: 'primary',
  ...(pin === undefined ? {} : { record_identity_scheme: pin }),
});

function insert(sqlite: Database, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  sqlite.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row) as never[]);
}

async function artifact(db: ReturnType<typeof sqliteD1>, transcripts: Record<string, unknown>[], extra: Array<{ t: string; r: Record<string, unknown> }> = []) {
  const rows = [...extra, ...transcripts.map(r => ({ t: 'transcripts', r }))];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.t] = (counts[row.t] ?? 0) + 1;
  return [
    { format: BACKUP_FORMAT, deploymentId: await deploymentId(db), schemaVersion: 92, createdAt: 1, producer: 'record pin test', counts },
    ...rows,
  ].map(value => JSON.stringify(value)).join('\n');
}

function snapshot(sqlite: Database) {
  const tables = sqlite.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return tables.map(({ name }) => [name, sqlite.query(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]);
}

describe('immutable record identity pin', () => {
  it('adds a legacy default to parsed, unread and in-flight v92 transcripts without changing held records or checkpoints', async () => {
    const sqlite = new Database(':memory:');
    try {
      for (const step of SCHEMA_STEPS.filter(step => step.version <= 92)) for (const statement of step.statements) sqlite.exec(statement);
      insert(sqlite, 'projects', { project_id: 'proj_1', name: 'record pins', created_at: 1 });
      for (const [id, state] of [
        ['parsed', { parsed_offset: 12, parser_version: 5, parsed_at: 1 }],
        ['unread', {}],
        ['inflight', { parsed_offset: 6, parser_version: 5, parser_context: '{"mycoParserState":{"chunked":true}}' }],
      ] as const) insert(sqlite, 'transcripts', { ...transcript(id), ...state });
      insert(sqlite, 'transcript_parser_state_chunks', { project_id: 'proj_1', transcript_id: 'inflight', cursor_offset: 6, chunk_index: 0, chunk_count: 1, payload: '{"pending":true}' });
      const children = [
        ['responses', { response_id: uuid(901), text: 'held reply', content_hash: 'reply' }],
        ['tool_calls', { tool_call_id: uuid(902), tool_name: 'Read', success: 1 }],
        ['plans', { plan_key: uuid(903), machine_id: 'machine_1', content: 'held plan', content_hash: 'plan', status: 'active', updated_at: 1 }],
      ] as const;
      for (const [table, fields] of children) insert(sqlite, table, { project_id: 'proj_1', session_id: 'record-scheme-session', event_id: uuid(900), created_at: 1, received_at: 1, token_id: 'token_1', ...fields });
      const frozen = children.map(([table]) => [table, sqlite.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all()]);
      const held = sqlite.query('SELECT * FROM transcripts ORDER BY transcript_id').all() as Record<string, unknown>[];
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([93, 94]);
      expect(sqlite.query('SELECT * FROM transcripts ORDER BY transcript_id').all()).toEqual(held.map(row => ({ ...row, record_identity_scheme: LEGACY })));
      expect(children.map(([table]) => [table, sqlite.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all().map(row => {
        if (table !== 'tool_calls') return row;
        const { result_reason, ...held } = row;
        expect(result_reason).toBeNull();
        return held;
      })])).toEqual(frozen);
      expect(sqlite.query('SELECT payload FROM transcript_parser_state_chunks').all()).toEqual([{ payload: '{"pending":true}' }]);
      expect(() => sqlite.exec(`UPDATE transcripts SET record_identity_scheme = '${SOURCE}' WHERE transcript_id = 'unread'`)).toThrow(/record_identity_scheme_immutable/);
      sqlite.exec(`UPDATE transcripts SET parsed_offset = 0, parser_context = NULL WHERE transcript_id = 'inflight'`);
      expect(sqlite.query(`SELECT record_identity_scheme FROM transcripts WHERE transcript_id = 'inflight'`).get()).toEqual({ record_identity_scheme: LEGACY });
    } finally { sqlite.close(); }
  });

  it('pins a new transcript independently of its prompt group and never repins an existing transcript on later segments', async () => {
    const e = sqliteEnv();
    try {
      const now = Date.now();
      const { tokenId } = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
      const oldId = `tx_${'1'.repeat(32)}`;
      const newId = `tx_${'2'.repeat(32)}`;
      insert(e.sqlite, 'transcripts', { ...transcript(oldId, LEGACY), agent: 'claude-code', prompt_identity_scheme: 'claude-v1', token_id: tokenId });
      const bytes = new TextEncoder().encode('{}\n');
      const key = await sha256HexOf(bytes);
      const objectKey = registerBlob(e.sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId, receivedAt: now });
      await e.bucket.put(objectKey, new Blob([bytes]).stream());
      for (const [event, id] of [[921, newId], [922, oldId]] as const) {
        const result = await ingestEvent(e.db, { projectId: 'proj_1', machineId: 'machine_1', tokenId, bodyBytes: 100, now }, envelope({ eventId: uuid(event),
          sessionId: 'record-scheme-session', kind: 'transcript.segment', createdAt: now,
          payload: { transcriptId: id, baseOffset: 0, length: bytes.length, blob: key, agent: 'claude-code' } }));
        expect(result).toMatchObject({ persisted: true });
      }
      expect(e.sqlite.query('SELECT transcript_id, prompt_identity_scheme, record_identity_scheme FROM transcripts ORDER BY transcript_id').all()).toEqual([
        { transcript_id: oldId, prompt_identity_scheme: 'claude-v1', record_identity_scheme: LEGACY },
        { transcript_id: newId, prompt_identity_scheme: 'claude-v1', record_identity_scheme: SOURCE },
      ]);
    } finally { e.sqlite.close(); }
  });

  it('renders validated per-agent CASE arms for two schemes, with the legacy default for absent declarations', () => {
    const sqlite = new Database(':memory:');
    try {
      const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'cursor')!.recordIdentity!;
      const declarations = { first: declaration, second: { ...declaration, scheme: LEGACY } };
      for (const [agent, expected] of [['first', SOURCE], ['second', LEGACY], ['unknown', LEGACY], [null, LEGACY]] as const) {
        const selected = admittedRecordScheme(agent, declarations);
        expect(sqlite.query(`SELECT ${selected.sql} AS pin`).get(...selected.params as never[])).toEqual({ pin: expected });
      }
      const hook = admittedRecordScheme('copilot');
      expect(sqlite.query(`SELECT ${hook.sql} AS pin`).get(...hook.params as never[])).toEqual({ pin: LEGACY });
      for (const bad of [
        { first: { ...declaration, scheme: 'unknown-v1' } },
        { "unsafe'agent": declaration },
        { first: { scheme: SOURCE, schemes: {} } },
      ]) expect(() => admittedRecordScheme('first', bad)).toThrow('record_identity_scheme_unsupported');
    } finally { sqlite.close(); }
  });
});

describe('whole-artifact record pin admission', () => {
  it('preserves mixed explicit pins and assigns legacy to older artifacts missing the field', async () => {
    const e = sqliteEnv();
    try {
      const text = await artifact(e.db, [transcript('old'), transcript('legacy', LEGACY), transcript('new', SOURCE)]);
      await restoreArtifact(e.db, { text, authorization: { kind: 'recovery' } });
      expect(e.sqlite.query('SELECT transcript_id, record_identity_scheme FROM transcripts ORDER BY transcript_id').all()).toEqual([
        { transcript_id: 'legacy', record_identity_scheme: LEGACY }, { transcript_id: 'new', record_identity_scheme: SOURCE }, { transcript_id: 'old', record_identity_scheme: LEGACY },
      ]);
      const before = snapshot(e.sqlite);
      await restoreArtifact(e.db, { text, authorization: { kind: 'recovery' } });
      expect(snapshot(e.sqlite)).toEqual(before);
    } finally { e.sqlite.close(); }
  });

  for (const [label, rows, held, code] of [
    ['destination disagreement', [transcript('same', SOURCE)], transcript('same', LEGACY), 'record_identity_scheme_conflict'],
    ['missing old pin disagreement', [transcript('same')], transcript('same', SOURCE), 'record_identity_scheme_conflict'],
    ['artifact duplicate disagreement', [transcript('same', SOURCE), transcript('same', LEGACY)], undefined, 'record_identity_scheme_conflict'],
    ['unsupported explicit pin', [transcript('same', 'future-v1')], undefined, 'record_identity_scheme_unsupported'],
    ['explicit null pin', [transcript('same', null)], undefined, 'record_identity_scheme_unsupported'],
  ] as const) {
    it(`refuses ${label} before any artifact row, raw reservation or progress write`, async () => {
      const e = sqliteEnv();
      try {
        if (held) insert(e.sqlite, 'transcripts', held);
        const text = await artifact(e.db, [...rows], [{ t: 'projects', r: { project_id: 'proj_other', name: 'must not land', created_at: 1 } }]);
        const before = snapshot(e.sqlite);
        await expect(restoreArtifact(e.db, { text, authorization: { kind: 'recovery' } })).rejects.toMatchObject({ code });
        expect(snapshot(e.sqlite)).toEqual(before);
      } finally { e.sqlite.close(); }
    });
  }

  it('compares pins by Project and transcript, independently of session groups', async () => {
    const e = sqliteEnv();
    try {
      insert(e.sqlite, 'transcripts', transcript('same', SOURCE));
      await expect(restoreRecordSchemeDecisions(e.db, [{ ...transcript('same', LEGACY), project_id: 'proj_other' }])).resolves.toBeUndefined();
    } finally { e.sqlite.close(); }
  });

  for (const [pin, code] of [[LEGACY, 'record_identity_scheme_conflict'], ['unknown-v1', 'record_identity_scheme_unsupported']] as const) {
    it(`answers HTTP 409 for ${code} through both restore entry points`, async () => {
      const e = sqliteEnv();
      try {
        insert(e.sqlite, 'transcripts', transcript('same', SOURCE));
        const text = await artifact(e.db, [transcript('same', pin)]);
        const bytes = new TextEncoder().encode(text);
        const key = `backups/record-${code}.jsonl`;
        await e.serverEnv.blobs.put(key, new Blob([bytes]).stream(), { httpMetadata: { contentType: 'application/jsonl' } });
        insert(e.sqlite, 'backups', { id: code, key, created_at: 1, size_bytes: bytes.length, schema_version: 92, counts_json: '{}', producer: 'record pin test', pinned: 0 });
        for (const [path, body] of [[`/api/backups/${code}/restore`, {}], ['/api/backups/restore-upload', { artifact: text }]] as const) {
          const response = await worker.fetch(await asOwnerPost(e.db, path, body), { ...e.env, ...OWNER_ENV });
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({ error: code });
        }
      } finally { e.sqlite.close(); }
    });
  }
});
