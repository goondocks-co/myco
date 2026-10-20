import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { parseTranscripts, TRANSCRIPT_IDLE_MS, PARSE_STOP_GENERATION } from '@myco-server-worker/ingest/parse.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';
import { sqliteEnv, blobPost, memberPost } from './helpers/fixtures.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';
import fs from 'node:fs';
import { deriveLegacyRecordId, extractRecordSource, RecordSourceAbsent, RecordSourceInvalid, type RecordIdScheme } from '@goondocks/myco-shared/record-identity';
import { uuidv5 } from '@myco-server-worker/hash.js';
import { parserCheckpointStatements, readParserCheckpoint } from '@myco-server-worker/ingest/parser-checkpoint.js';
import type { DerivedEvent, ParserInput, ParserState } from '@myco-server-worker/ingest/parsers/index.js';
import { claudeCodeParser } from '@myco-server-worker/ingest/parsers/claude-code.js';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { PROCESSED_FIELDS } from '@myco-server-worker/core/processed-resources.js';
import { READ_BEFORE_PIN } from '@myco-server-worker/ingest/prompt-scheme.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';

const NOW = Date.now();
const SESSION = 'record-identity-session';
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

function reply(agent: string, text: string, key: string): string {
  switch (agent) {
    case 'claude-code': return line({ type: 'assistant', uuid: key, message: { content: [{ type: 'text', text }] } });
    case 'codex': return line({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: key, content: [{ type: 'output_text', text }] } });
    case 'pi': return line({ type: 'message', id: key, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    case 'cursor': return line({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
    default: return line({ v: 1, type: 'response', text, at: NOW });
  }
}

async function rig(agent: string) {
  const e = sqliteEnv();
  const issued = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  const env = { ...e.env, ...OWNER_ENV };
  const ship = async (transcriptId: string, text: string, role: 'primary' | 'subagent' = 'primary', baseOffset = 0): Promise<void> => {
    const bytes = new TextEncoder().encode(text);
    const key = await sha256HexOf(bytes);
    const upload = await worker.fetch(blobPost(issued.token, key, bytes), env);
    expect(upload.status).toBe(200);
    const result = await worker.fetch(memberPost(issued.token, {
      eventId: crypto.randomUUID(), sessionId: SESSION, kind: 'transcript.segment', channel: 'cli', createdAt: NOW,
      producer: { adapter: agent, version: '1' },
      payload: { transcriptId, agent, role, baseOffset, length: bytes.byteLength, blob: key },
    }), env);
    expect(await result.json()).toMatchObject({ persisted: true });
  };
  const settle = async (): Promise<void> => {
    for (let n = 0; n < 12; n += 1) await parseTranscripts(e.serverEnv, NOW + TRANSCRIPT_IDLE_MS * 2);
    expect(e.sqlite.query('SELECT parse_error FROM transcripts').all()).toEqual(
      e.sqlite.query('SELECT transcript_id FROM transcripts').all().map(() => ({ parse_error: null })),
    );
  };
  const reread = async (): Promise<void> => {
    const pins = e.sqlite.query('SELECT transcript_id, record_identity_scheme FROM transcripts ORDER BY transcript_id').all();
    const result = await worker.fetch(await asOwnerPost(e.db, '/api/transcripts/reread', { projectId: 'proj_1', sessionId: SESSION }), env);
    expect(result.status).toBe(200);
    expect(e.sqlite.query('SELECT transcript_id, record_identity_scheme FROM transcripts ORDER BY transcript_id').all()).toEqual(pins);
    await settle();
  };
  const responses = () => e.sqlite.query('SELECT response_id, text, event_id FROM responses ORDER BY text').all();
  const assertReferences = (): void => {
    for (const [kind, table, key, payloadKey] of [['response', 'responses', 'response_id', 'responseId'], ['tool.use', 'tool_calls', 'tool_call_id', 'toolCallId'], ['tool.failure', 'tool_calls', 'tool_call_id', 'toolCallId']] as const) {
      expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM events e LEFT JOIN ${table} r ON r.project_id=e.project_id AND r.${key}=json_extract(e.payload,'$.${payloadKey}')
        WHERE e.kind=? AND (r.${key} IS NULL OR r.session_id<>e.session_id)`).get(kind)).toEqual({ n: 0 });
    }
    for (const [kind, field] of Object.entries(PROCESSED_FIELDS)) {
      expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM processed_resources pr LEFT JOIN ${field.table} p ON p.project_id=pr.project_id AND p.${field.id}=pr.resource_id
        LEFT JOIN blobs b ON b.project_id=pr.project_id AND b.key=pr.blob_key
        WHERE pr.kind=? AND (p.${field.id} IS NULL OR b.key IS NULL OR p.${field.blob}<>pr.blob_key)`).get(kind)).toEqual({ n: 0 });
    }
  };
  return { ...e, ship, settle, reread, responses, assertReferences };
}

describe('declared record identity through segment upload and owner reread', () => {
  for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
    it(`${recordScheme}: an undeclared emitted kind stops in its named parse branch before any derived event lands`, async () => {
      const e = await rig('cursor');
      const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'cursor')!.recordIdentity!;
      const rules = declaration.schemes[recordScheme]!;
      const rule = rules.response;
      try {
        const tx = 'tx_11111111111111111111111111111111';
        if (recordScheme === 'legacy-session-v1') e.sqlite.run(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,segment_count,first_received_at,last_received_at,token_id,prompt_identity_scheme)
          VALUES ('proj_1',?,?,'machine_1','cursor',0,0,0,0,'mt_x','offset-v1')`, [tx, SESSION]);
        await e.ship(tx, reply('cursor', 'must not land', 'unused'));
        delete rules.response;
        await parseTranscripts(e.serverEnv, NOW + TRANSCRIPT_IDLE_MS * 2);
        const row = e.sqlite.query('SELECT parsed_offset, parse_error, parser_context FROM transcripts').get() as { parsed_offset: number; parse_error: string; parser_context: string };
        expect(row).toMatchObject({ parsed_offset: 0, parse_error: 'parse' });
        expect(JSON.parse(row.parser_context).mycoParserFailure.branch).toBe('record_kind_undeclared');
        expect(e.responses()).toEqual([]);
        expect(e.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE kind <> 'transcript.segment'").get()).toEqual({ n: 0 });
      } finally {
        rules.response = rule;
        e.sqlite.close();
      }
    });
  }

  it('segment admission uses the current manifest declaration rather than a literal record scheme', async () => {
    const e = await rig('cursor');
    const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'cursor')!.recordIdentity!;
    const scheme = declaration.scheme;
    try {
      Object.assign(declaration, { scheme: 'legacy-session-v1' });
      await e.ship('tx_11111111111111111111111111111111', reply('cursor', 'declared legacy', 'unused'));
      expect(e.sqlite.query('SELECT record_identity_scheme FROM transcripts').get()).toEqual({ record_identity_scheme: 'legacy-session-v1' });
    } finally {
      Object.assign(declaration, { scheme });
      e.sqlite.close();
    }
  });
  for (const agent of Object.keys(PARSERS)) {
    it(`${agent}: different records at the same offset in one session survive reread`, async () => {
      const e = await rig(agent);
      try {
        await e.ship('tx_11111111111111111111111111111111', reply(agent, 'first reply', 'first-record'));
        await e.ship('tx_22222222222222222222222222222222', reply(agent, 'other reply', 'other-record'), agent === 'claude-code' ? 'subagent' : 'primary');
        await e.settle();
        const before = e.responses();
        expect(before).toHaveLength(2);
        expect(before.map(row => (row as { text: string }).text)).toEqual(['first reply', 'other reply']);
        await e.reread();
        expect(e.responses()).toEqual(before);
        e.assertReferences();
      } finally { e.sqlite.close(); }
    });
  }

  for (const [variant, record] of fs.readFileSync(new URL('../fixtures/record-identity-chunks.jsonl', import.meta.url), 'utf8').trim().split('\n').map(text => JSON.parse(text)).entries()) {
    it(`Claude two-block chunk bound ${variant}: distinct original block anchors survive stored checkpoint reload and reread`, async () => {
      const e = await rig('claude-code');
      try {
        const tx = 'tx_33333333333333333333333333333333';
        await e.ship(tx, line(record));
        await parseTranscripts(e.serverEnv, NOW);
        const context = JSON.parse((e.sqlite.query('SELECT parser_context FROM transcripts').get() as { parser_context: string }).parser_context);
        expect(context.mycoParserState.reply.parts[0].source).toEqual(
          variant === 0 ? { key: 'two-block-key', thread: 'main', block: 3 } : { position: true, block: 3 },
        );
        await e.settle();
        const before = e.responses();
        expect(before).toHaveLength(2);
        expect(new Set(before.map(row => (row as { response_id: string }).response_id)).size).toBe(2);
        expect(before.map(row => (row as { text: string }).text)).toEqual(['a'.repeat(132000), 'b'.repeat(132000)]);
        await e.reread();
        expect(e.responses()).toEqual(before);
      } finally { e.sqlite.close(); }
    });
  }

  it('a copied Claude record dedupes replies, keyed tools and plans while each transcript retains its events', async () => {
    const e = await rig('claude-code');
    try {
      const body = line({ type: 'assistant', uuid: 'copied-assistant', message: { content: [
        { type: 'text', text: '<ultraplan># Copied plan</ultraplan>' }, { type: 'tool_use', id: 'copied-call', name: 'Read', input: { body: 'x'.repeat(6000) } },
      ] } }) + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'copied-call', content: 'ok' }] } });
      await e.ship('tx_11111111111111111111111111111111', body);
      await e.ship('tx_22222222222222222222222222222222', body);
      await e.settle();
      for (const table of ['responses', 'tool_calls', 'plans']) expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
      expect(e.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE kind='response'").get()).toEqual({ n: 2 });
      expect((e.sqlite.query('SELECT COUNT(*) AS n FROM tool_calls WHERE input_bundle_id IS NOT NULL').get() as { n: number }).n).toBeGreaterThan(0);
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM tool_calls t LEFT JOIN archive_bundles a ON a.project_id=t.project_id AND a.id=t.input_bundle_id LEFT JOIN blobs b ON b.project_id=a.project_id AND b.key=a.archive_key WHERE t.input_bundle_id IS NOT NULL AND (a.id IS NULL OR b.key IS NULL)').get()).toEqual({ n: 0 });
      e.assertReferences();
      const before = e.responses();
      await e.reread();
      expect(e.responses()).toEqual(before);
    } finally { e.sqlite.close(); }
  });

  it('same-tag plans at equal offsets keep their own rows, envelopes and original block positions', async () => {
    const e = await rig('claude-code');
    try {
      const body = (uuid: string, name: string) => line({ type: 'assistant', uuid, message: { content: [
        { type: 'text', text: `<ultraplan></ultraplan><ultraplan># ${name} first</ultraplan><ultraplan># ${name} next</ultraplan>` },
        { type: 'thinking' }, { type: 'text', text: `<ultraplan># ${name} other block</ultraplan>` },
      ] } });
      await e.ship('tx_11111111111111111111111111111111', body('plan-first', 'One'));
      await e.ship('tx_22222222222222222222222222222222', body('plan-other', 'Two'));
      await e.settle();
      const plans = () => e.sqlite.query('SELECT plan_key, content, event_id FROM plans ORDER BY plan_key').all();
      const before = plans();
      expect(before).toHaveLength(6);
      expect(e.sqlite.query("SELECT COUNT(*) AS n FROM tags t LEFT JOIN plans p ON p.project_id=t.project_id AND p.plan_key=t.entity_id WHERE t.entity_kind='plan' AND p.plan_key IS NULL").get()).toEqual({ n: 0 });
      await e.reread();
      expect(plans()).toEqual(before);
    } finally { e.sqlite.close(); }
  });

  it('retention of a later source record does not renumber its plan on reread', async () => {
    const e = await rig('claude-code');
    try {
      const tx = 'tx_11111111111111111111111111111111';
      const prefix = reply('claude-code', '<ultraplan># Prefix</ultraplan>', 'prefix');
      const tail = reply('claude-code', '<ultraplan># Retained</ultraplan>', 'tail');
      await e.ship(tx, prefix);
      await e.ship(tx, tail, 'primary', Buffer.byteLength(prefix));
      await e.settle();
      const before = e.sqlite.query("SELECT plan_key, event_id, content FROM plans WHERE content='# Retained'").get();
      e.sqlite.run('DELETE FROM transcript_segments WHERE base_offset=0');
      await e.reread();
      expect(e.sqlite.query("SELECT plan_key, event_id, content FROM plans WHERE content='# Retained'").all()).toEqual([before]);
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 2 });
    } finally { e.sqlite.close(); }
  });

  for (const agent of Object.keys(PARSERS)) {
    it(`${agent}: mixed record pins and logical/event ids round-trip through backup, restore and reread`, async () => {
      const e = await rig(agent);
      try {
        const legacyTx = 'tx_11111111111111111111111111111111';
        e.sqlite.run(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,segment_count,first_received_at,last_received_at,token_id,prompt_identity_scheme)
          VALUES ('proj_1',?,?,'machine_1',?,0,0,0,0,'mt_x',?)`, [legacyTx, SESSION, agent, READ_BEFORE_PIN[agent]!]);
        await e.ship(legacyTx, reply(agent, 'legacy reply', 'old-key'));
        await e.ship('tx_22222222222222222222222222222222', reply(agent, 'source reply', 'new-key'));
        await e.settle();
        const before = e.responses();
        expect(before).toHaveLength(2);
        const legacyId = await deriveLegacyRecordId(uuidv5, { kind: 'response', sessionId: SESSION, offset: 0 });
        expect(before[0]).toEqual({ response_id: legacyId, text: 'legacy reply', event_id: await uuidv5('transcript-event', legacyTx, 'response', legacyId) });
        const backup = await createBackup(e.db, e.bucket, { producer: 'record-identity-test', now: NOW });
        const artifact = await backupArtifact(e.db, e.bucket, backup.id);
        expect(artifact).not.toBeNull();
        e.sqlite.run('DELETE FROM responses');
        await restoreArtifact(e.db, { text: artifact!.text, blobs: e.bucket, authorization: { kind: 'recovery' } });
        expect(e.responses()).toEqual(before);
        await e.reread();
        expect(e.responses()).toEqual(before);
        expect(e.sqlite.query('SELECT record_identity_scheme FROM transcripts ORDER BY transcript_id').all()).toEqual([
          { record_identity_scheme: 'legacy-session-v1' }, { record_identity_scheme: 'source-record-v1' },
        ]);
        e.assertReferences();
      } finally { e.sqlite.close(); }
    });
  }
});

describe('record source continuation and pure extraction', () => {
  const input = (recordScheme: RecordIdScheme = 'source-record-v1'): Omit<ParserInput, 'lines'> => ({
    sessionId: SESSION, transcriptId: 'tx_44444444444444444444444444444444', recordScheme, scheme: 'claude-v1', now: NOW,
  });
  const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/record-identity-chunks.jsonl', import.meta.url), 'utf8').split('\n')[0]);
  const ordered = (events: DerivedEvent[]) => events.toSorted((a, b) => a.offset - b.offset || String(a.payload.responseId).localeCompare(String(b.payload.responseId)));

  for (const keyed of [true, false]) {
    for (const chunked of [false, true]) {
      it(`keyed=${keyed}, chunked=${chunked}: held anchor survives serializer reload with identical final ids and text`, async () => {
        const e = sqliteEnv();
        try {
          const record = structuredClone(fixture);
          if (!keyed) delete record.uuid;
          const base = input();
          const lines = [{ value: record, offset: 0 }];
          const parser = PARSERS['claude-code'];
          const whole = await parser.parse({ ...base, lines });
          const state: ParserState = {};
          const first = await parser.parse({ ...base, lines, state });
          expect(state.reply?.parts[0].source?.block).toBe(3);
          if (chunked) state.pending = { large: { toolCallId: 'held-tool', toolName: 'Read', input: { body: 'x'.repeat(180000) }, createdAt: NOW, offset: 0 } };
          const target = { projectId: 'proj_1', transcriptId: base.transcriptId, parsedOffset: 1 };
          e.sqlite.run(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,segment_count,first_received_at,last_received_at,token_id,record_identity_scheme) VALUES ('proj_1',?,?,'machine_1',1,1,0,0,'mt_x','source-record-v1')`, [base.transcriptId, SESSION]);
          await e.db.batch(await parserCheckpointStatements(e.db, target, 1, state, undefined, false,
            context => e.db.prepare('UPDATE transcripts SET parsed_offset=1,parser_context=? WHERE transcript_id=?').bind(context, base.transcriptId)));
          const context = JSON.parse((e.sqlite.query('SELECT parser_context FROM transcripts').get() as { parser_context: string }).parser_context);
          expect(context.mycoParserState.chunked === true).toBe(chunked);
          const reloaded: ParserState = chunked ? await readParserCheckpoint(e.db, target, context.mycoParserState.digest) : context.mycoParserState;
          delete reloaded.pending;
          const final = await parser.parse({ ...base, lines: [], state: reloaded, terminal: 'complete_file' });
          expect(ordered([...first, ...final])).toEqual(ordered(whole));
        } finally { e.sqlite.close(); }
      });
    }
  }

  it('every inner reply pin exposes its declared source outside payload and the wrapped derive exposes legacy ids', async () => {
    for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
      const base = input(recordScheme);
      const lines = [{ value: { type: 'assistant', uuid: 'assistant-key', message: { content: [{ type: 'text', text: 'reply' }] } }, offset: 12 }];
      const fragment = (await claudeCodeParser.parse({ ...base, lines }))[0];
      expect(fragment.source).toEqual({ key: 'assistant-key', thread: 'main', block: 0 });
      expect(fragment.payload.responseId).toBeUndefined();
      expect(fragment.payload.source).toBeUndefined();
      const derived = (await PARSERS['claude-code'].parse({ ...base, lines }))[0];
      expect(derived.source).toEqual(fragment.source);
      expect(derived.legacyId).toBe(await deriveLegacyRecordId(uuidv5, { kind: 'response', sessionId: SESSION, offset: 12 }));
    }
  });

  for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
    it(`Pi ${recordScheme}: keyless invocations are skipped and the remaining transcript is parsed`, async () => {
      const e = await rig('pi');
      const tx = 'tx_11111111111111111111111111111111';
      try {
        if (recordScheme === 'legacy-session-v1') e.sqlite.run(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,segment_count,first_received_at,last_received_at,token_id,prompt_identity_scheme)
          VALUES ('proj_1',?,?,'machine_1','pi',0,0,0,0,'mt_x','offset-v1')`, [tx, SESSION]);
        await e.ship(tx, line({ type: 'message', id: 'pi-reply', message: { role: 'assistant', content: [
          { type: 'toolCall', name: 'Read', arguments: {} }, { type: 'toolCall', id: '', name: 'Read', arguments: {} },
          { type: 'text', text: 'remaining reply' },
        ] } }));
        await e.settle();
        expect(e.responses().map(row => (row as { text: string }).text)).toEqual(['remaining reply']);
        expect(e.sqlite.query('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 0 });
        expect(e.sqlite.query('SELECT record_identity_scheme, parsed_offset = size AS complete FROM transcripts').get())
          .toEqual({ record_identity_scheme: recordScheme, complete: 1 });
      } finally { e.sqlite.close(); }
    });
  }

  for (const variant of ['stored', 'record'] as const) {
    it(`an invalid ${variant} source stops only its transcript with a content-free identity branch`, async () => {
      const e = await rig('claude-code');
      try {
        const bad = 'tx_11111111111111111111111111111111';
        const good = 'tx_22222222222222222222222222222222';
        await e.ship(bad, variant === 'record' ? line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'key\0invalid', name: 'Read', input: {} }] } }) : reply('claude-code', 'invalid-source-content', 'key'));
        if (variant === 'stored') e.sqlite.run('UPDATE transcripts SET parser_context = ? WHERE transcript_id = ?', [JSON.stringify({
          mycoParserState: { reply: { parts: [{ text: 'held-source-content', offset: 0, createdAt: NOW, source: { key: 'key', block: -1 } }], chars: 19, bytes: 19 } },
        }), bad]);
        await e.ship(good, reply('claude-code', 'healthy reply', 'healthy-key'));
        await parseTranscripts(e.serverEnv, NOW + TRANSCRIPT_IDLE_MS * 2);
        const row = e.sqlite.query('SELECT parsed_offset, parse_error, parser_context FROM transcripts WHERE transcript_id = ?').get(bad) as { parsed_offset: number; parse_error: string; parser_context: string };
        expect(row).toMatchObject({ parsed_offset: 0, parse_error: 'parse' });
        expect(JSON.parse(row.parser_context).mycoParserFailure).toEqual({ branch: 'record_source_invalid', offset: 0, lineKind: 'unknown', generation: PARSE_STOP_GENERATION });
        expect(e.responses().map(row => (row as { text: string }).text)).toEqual(['healthy reply']);
      } finally { e.sqlite.close(); }
    });
  }

  it('legacy tool ids use their retained rule when the current declaration changes tool paths', async () => {
    const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === 'claude-code')!.recordIdentity!;
    const original = { scheme: declaration.scheme, schemes: declaration.schemes };
    try {
      Object.assign(declaration, { scheme: 'source-record-v2', schemes: { ...declaration.schemes, 'source-record-v2': {
        ...declaration.schemes['source-record-v1'], 'tool-call': {
          key: { from: 'call', path: 'replacement' }, resultKey: { from: 'result', path: 'replacement' }, evidence: 'synthetic',
        },
      } } });
      const events = await PARSERS['claude-code'].parse({ ...input('legacy-session-v1'), lines: [
        { offset: 0, value: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'legacy-call', replacement: 'current-call', name: 'Read', input: {} }] } } },
        { offset: 100, value: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'legacy-call', replacement: 'current-call', content: 'ok' }] } } },
      ] });
      expect(events).toHaveLength(1);
      expect(events[0].source).toEqual({ key: 'legacy-call', block: 0 });
      expect(events[0].payload.toolCallId).toBe(await deriveLegacyRecordId(uuidv5, { kind: 'tool-call', sessionId: SESSION, offset: 0, source: { key: 'legacy-call', block: 0 } }));
    } finally { Object.assign(declaration, original); }
  });

  for (const agent of ['claude-code', 'codex']) {
    it(`${agent}: skips keyless calls under both pins even when their declaration permits position`, async () => {
      const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === agent)!.recordIdentity!;
      for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
        const rule = declaration.schemes[recordScheme]!['tool-call']!;
        const original = rule.absentKey;
        try {
          rule.absentKey = 'position';
          const calls = [undefined, ''].map(id => agent === 'claude-code'
            ? { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } }
            : { type: 'response_item', payload: { type: 'function_call', call_id: id, name: 'Read', arguments: '{}' } });
          const events = await PARSERS[agent]!.parse({ ...input(recordScheme), scheme: READ_BEFORE_PIN[agent]!, lines: [
            ...calls.map((value, offset) => ({ value, offset })),
            { offset: 20, value: JSON.parse(reply(agent, 'kept reply', 'reply-key')) },
          ] });
          expect(events.map(event => [event.kind, event.payload.text])).toEqual([['response', 'kept reply']]);
        } finally {
          if (original === undefined) delete rule.absentKey;
          else rule.absentKey = original;
        }
      }
    });
  }

  for (const agent of Object.keys(PARSERS)) {
    it(`${agent}: unavailable current response and plan facts leave legacy parsing and checkpoints unchanged`, async () => {
      const parser = PARSERS[agent]!;
      const declaration = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === agent)!.recordIdentity!;
      const base = { ...input('legacy-session-v1'), scheme: READ_BEFORE_PIN[agent]! };
      const text = parser.planTags.map(tag => `<${tag}># Kept plan</${tag}>`).join('\n') || 'kept reply';
      const lines = [{ offset: 12, value: JSON.parse(reply(agent, text, 'reply-key')) }];
      const expected = await parser.parse({ ...base, lines });
      const checkpoints = [];
      for (let split = 0; split <= lines.length; split += 1) {
        const state: ParserState = {};
        await parser.parse({ ...base, state, lines: lines.slice(0, split) });
        checkpoints.push(JSON.stringify(state));
      }
      const original = { scheme: declaration.scheme, schemes: declaration.schemes };
      try {
        const current = Object.fromEntries(Object.entries(declaration.schemes[declaration.scheme]!).map(([kind, rule]) => {
          if (kind === 'tool-call') return [kind, rule];
          const { position: _position, absentKey: _absentKey, ...retained } = rule;
          return [kind, { ...retained, key: { from: 'record', path: 'unavailableCurrentKey' } }];
        }));
        Object.assign(declaration, { scheme: 'source-record-v2', schemes: { ...declaration.schemes, 'source-record-v2': current } });
        expect(() => extractRecordSource({ declaration, scheme: 'source-record-v2' as never, kind: 'response', record: lines[0].value, block: 0 }))
          .toThrow(RecordSourceAbsent);
        const actual = await parser.parse({ ...base, lines });
        expect(actual.length).toBeGreaterThan(0);
        expect(actual.every(event => event.source === undefined)).toBe(true);
        expect(actual).toEqual(expected.map(event => ({ ...event, source: undefined })));
        for (let split = 0; split <= lines.length; split += 1) {
          const state: ParserState = {};
          const first = await parser.parse({ ...base, state, lines: lines.slice(0, split) });
          expect(JSON.stringify(state)).toBe(checkpoints[split]!);
          const second = await parser.parse({ ...base, state: JSON.parse(JSON.stringify(state)), lines: lines.slice(split), terminal: 'complete_file' });
          expect([...first, ...second].map(event => [event.kind, event.payload, event.legacyId]))
            .toEqual(expected.map(event => [event.kind, event.payload, event.legacyId]));
          expect([...first, ...second].every(event => event.source === undefined)).toBe(true);
        }
      } finally { Object.assign(declaration, original); }
    });
  }

  it('a restored legacy reply with no source facts emits no invented positional source', async () => {
    const state: ParserState = {};
    await PARSERS['claude-code'].parse({ ...input('legacy-session-v1'), state, lines: [
      { offset: 12, value: { type: 'assistant', uuid: 'key', message: { content: [{ type: 'text', text: 'held' }] } } },
    ] });
    const events = await PARSERS['claude-code'].parse({ ...input('legacy-session-v1'), state: JSON.parse(JSON.stringify(state)), lines: [], terminal: 'complete_file' });
    expect(events).toHaveLength(1);
    expect(events[0].payload.text).toBe('held');
    expect(events[0].source).toBeUndefined();
    expect(events[0].payload.responseId).toBe(events[0].legacyId);
  });

  it('a new-scheme checkpoint with an absent source fails instead of substituting an offset', async () => {
    await expect(PARSERS['claude-code'].parse({ ...input(), lines: [], terminal: 'complete_file', state: {
      reply: { parts: [{ text: 'held', offset: 12, createdAt: NOW }], chars: 4, bytes: 4 },
    } })).rejects.toThrow(RecordSourceInvalid);
  });

  it('tool shapes with no declared key leave the remaining source record readable under every pin', async () => {
    for (const recordScheme of ['legacy-session-v1', 'source-record-v1'] as const) {
      const events = await PARSERS['claude-code'].parse({ ...input(recordScheme), lines: [{ offset: 0, value: {
        type: 'assistant', uuid: 123, message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'kept reply' }] },
      } }] });
      expect(events.map(event => [event.kind, event.payload.text, event.source])).toEqual([
        ['response', 'kept reply', { position: true, block: 1 }],
      ]);
    }
  });

  it('Pi numeric keyed calls cannot alias keyless result positions', async () => {
    const events = await PARSERS.pi.parse({ ...input(), scheme: 'offset-v1', lines: [
      { offset: 0, value: { type: 'message', message: { role: 'toolResult', toolCallId: '123', toolName: 'Read', content: 'keyed' } } },
      { offset: 123, value: { type: 'message', message: { role: 'toolResult', toolName: 'Read', content: 'positional' } } },
    ] });
    expect(events).toHaveLength(2);
    expect(events[0].payload.toolCallId).not.toBe(events[1].payload.toolCallId);
    expect(events[0].legacyId).toBe(events[1].legacyId);
  });
});
