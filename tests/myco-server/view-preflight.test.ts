import { statementRecorder } from '../helpers/statement-recorder.js';
import { preflightCoverage, preflightCoveragePins } from '@myco-server-worker/read/view-store.js';
import { expect, test } from 'bun:test';
import { withViewStores, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import {
  readViewPreflightPage,
  encodeViewPreflightCursor,
  decodeViewPreflightCursor,
  type PreflightCursor,
} from '@myco-server-worker/core/view-preflight.js';
import {
  coverageCandidate,
  carriesCoverage,
  carriesCoverageSql,
  type CoverageIdentity,
} from '@myco-server-worker/core/coverage-carry.js';
import { handleStatus } from '@myco-server-worker/api/status.js';
import { deploymentIdentity } from '@myco-server-worker/auth/authorization.js';
import type { OwnerContext } from '@myco-server-worker/context.js';

test('preflight resumes metadata pages without reading blobs or writing and admits only the selected owner', async () => {
  await withViewStores(async (db, name) => {
    const now = Date.now(),
      blobs = memoryBlobStore();
    await captureViewSession(db);
    const source = JSON.stringify({ role: 'user', message: { content: 'metadata only' } }) + '\n';
    const env = await captureViewTranscript(db, blobs, 'session', 'tx_0123456789abcdef0123456789abcdef', source, now);
    const before = blobs.gets.length;
    let cursor: PreflightCursor | null = { stage: 'transcripts', id: '' },
      pages = 0;
    const complete: { heldFromZero?: boolean | null }[] = [];
    const readonly = {
      ...db,
      prepare: (sql: string) => {
        if (/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) throw new Error('preflight attempted a write');
        return db.prepare(sql);
      },
    };
    while (cursor && pages++ < 32) {
      const page = await readViewPreflightPage(readonly, 'project', cursor);
      complete.push(...page.transcripts.filter((row) => 'heldFromZero' in row));
      if (page.coverage)
        expect(page.coverage.acknowledged).toBe(page.coverage.reofferedFloor + page.coverage.carryCeiling);
      cursor = page.nextCursor
        ? decodeViewPreflightCursor('project', encodeViewPreflightCursor('project', page.nextCursor))
        : null;
    }
    expect(cursor, name).toBeNull();
    expect(complete).toContainEqual(expect.objectContaining({ heldFromZero: true }));
    expect(blobs.gets.length).toBe(before);
    const token = encodeViewPreflightCursor('project', { stage: 'coverage', id: '' });
    expect(() => decodeViewPreflightCursor('other', token)).toThrow('invalid_preflight_cursor');
    expect(() => decodeViewPreflightCursor('project', 'malformed')).toThrow('invalid_preflight_cursor');
    const url = new URL('https://fixture/api/status?viewPreflight&project=project');
    const ctx: OwnerContext = {
      source: '127.0.0.1',
      member: { id: 'member', label: 'member', role: 'admin' },
      now,
      url,
      params: {},
      request: new Request(url),
      session: { aud: await deploymentIdentity(db), sub: 'fixture', login: 'fixture', iat: now, exp: now + 60000 },
      config: { clientId: 'fixture', clientSecret: 'fixture', sessionSecret: 'fixture' },
    };
    let inventories = 0;
    const checked = {
      ...db,
      prepare: (sql: string) => {
        if (/transcript_id,size,parsed_offset\s+FROM transcripts/.test(sql)) inventories++;
        return db.prepare(sql);
      },
    };
    expect((await handleStatus({ ...env, db: checked }, ctx)).status).toBe(403);
    expect(inventories).toBe(0);
    await db.prepare(`UPDATE deployment_ownership SET member_id='member' WHERE id=1`).run();
    expect((await handleStatus({ ...env, db: checked }, ctx)).status).toBe(200);
    expect(inventories).toBe(1);
  });
}, 120000);

test('coverage carry requires complete canonical source identity or an admitted record-naming scheme', () => {
  const row: CoverageIdentity = {
    id: 'prompt',
    claim: 'owner',
    key: 'key',
    thread: 'thread',
    record: 'record',
    scheme: 'claude-v2',
  };
  expect(carriesCoverage(row, { ...row, id: 'different-public-id' })).toBe(true);
  for (const field of ['claim', 'key', 'thread', 'record'] as const)
    expect(carriesCoverage(row, { ...row, [field]: null })).toBe(false);
  const positional = { ...row, claim: null, key: null, thread: null, record: null, scheme: 'offset-v1' };
  expect(coverageCandidate(positional)).toBe(false);
  expect(carriesCoverage(positional, positional)).toBe(false);
  for (const scheme of ['claude-v1', 'claude-v2']) {
    expect(carriesCoverage({ ...positional, scheme }, { ...positional, scheme })).toBe(false);
    expect(
      carriesCoverage({ ...positional, scheme, shape: 'queued' }, { ...positional, scheme, shape: 'queued' }),
    ).toBe(true);
  }
  for (const scheme of ['stamp-or-offset-v1', 'stamp-or-offset-v2'])
    expect(
      carriesCoverage({ ...positional, scheme, shape: 'stamped' }, { ...positional, scheme, shape: 'stamped' }),
    ).toBe(true);
});

test('transactional and metadata coverage rules agree for partial identities and positional, queued and stamped records', async () => {
  const fields = ['id', 'claim', 'key', 'thread', 'record', 'scheme', 'shape'] as const;
  const expressions = (side: string) =>
    Object.fromEntries(fields.map((field) => [field, `json_extract(j.value,'$.${side}.${field}')`])) as Record<
      (typeof fields)[number],
      string
    >;
  const cases: { legacy: CoverageIdentity; current: CoverageIdentity }[] = [];
  for (const scheme of ['offset-v1', 'claude-v1', 'claude-v2', 'stamp-or-offset-v1', 'stamp-or-offset-v2']) {
    for (const shape of [undefined, 'queued', 'stamped'] as const) {
      for (let mask = 0; mask < 16; mask++) {
        const identity = {
          id: 'held',
          claim: mask & 1 ? 'owner' : null,
          key: mask & 2 ? 'key' : null,
          thread: mask & 4 ? 'thread' : null,
          record: mask & 8 ? 'record' : null,
          scheme,
          shape,
        };
        for (const current of [identity, { ...identity, id: 'another' }, { ...identity, record: 'different' }])
          cases.push({ legacy: identity, current });
      }
    }
  }
  const expected = cases.map((row) => (carriesCoverage(row.legacy, row.current) ? 1 : 0));
  await withViewStores(async (db, target) => {
    const actual = (
      await db
        .prepare(
          `SELECT CASE WHEN ${carriesCoverageSql(expressions('legacy'), expressions('current'))} THEN 1 ELSE 0 END carried
    FROM json_each(?) j ORDER BY CAST(j.key AS INTEGER)`,
        )
        .bind(JSON.stringify(cases))
        .all<{ carried: number }>()
    ).results;
    expect(
      actual.map((row) => row.carried),
      target,
    ).toEqual(expected);
  });
}, 60000);

test('coverage, transcript pins and inventory keysets resume bounded pages with partial sums', async () => {
  await withViewStores(async (db, store) => {
    const { prepareInjectionReceipt, commitContextWrite } = await import('@myco-server-worker/core/context-writes.js');
    const now = Date.now(),
      blobs = memoryBlobStore();
    await captureViewSession(db);
    await captureViewTranscript(
      db,
      blobs,
      'session',
      'tx_' + 'f'.repeat(32),
      JSON.stringify({ role: 'user', message: { content: 'metadata only' } }) + '\n',
      now,
    );
    const clone = async (table: 'prompt_batches' | 'plans' | 'transcripts', rows: Record<string, unknown>[]) => {
      const columns = Object.keys(rows[0]!);
      await db
        .prepare(
          `INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map((column) => `json_extract(value,'$.${column}')`).join(',')} FROM json_each(?)`,
        )
        .bind(JSON.stringify(rows))
        .run();
    };
    const prompt = (await db
      .prepare('SELECT * FROM prompt_batches WHERE project_id=? LIMIT 1')
      .bind('project')
      .first<Record<string, unknown>>())!;
    await db
      .prepare('UPDATE events SET producer_adapter=? WHERE project_id=?')
      .bind('transcript-parse', 'project')
      .run();
    await db.prepare('UPDATE prompt_batches SET processed=1 WHERE project_id=?').bind('project').run();
    await clone(
      'prompt_batches',
      Array.from({ length: 200 }, (_, i) => ({
        ...prompt,
        prompt_id: 'page-' + String(i).padStart(4, '0'),
        created_at: now - (i % 7),
        processed: 1,
      })),
    );
    const transcript = (await db
      .prepare('SELECT * FROM transcripts WHERE project_id=? LIMIT 1')
      .bind('project')
      .first<Record<string, unknown>>())!;
    await clone(
      'transcripts',
      Array.from({ length: 130 }, (_, i) => ({
        ...transcript,
        transcript_id: 'tx_' + i.toString(16).padStart(32, '0'),
      })),
    );
    const plan = (await db
      .prepare('SELECT * FROM plans WHERE project_id=? LIMIT 1')
      .bind('project')
      .first<Record<string, unknown>>())!;
    await clone(
      'plans',
      Array.from({ length: 130 }, (_, i) => ({
        ...plan,
        plan_key: 'page-plan-' + String(i).padStart(4, '0'),
        source: 'tag',
        origin_path: 'transcript:fixture',
      })),
    );
    await commitContextWrite(
      db,
      prepareInjectionReceipt(
        db,
        {
          project: 'project',
          session: 'session',
          id: 'page-receipt',
          promptId: null,
          scopeReason: 'absent_key',
          protocol: 'legacy',
          askedAt: null,
          promptHash: 'many-plans',
          spores: [],
          plans: Array.from({ length: 150 }, (_, i) => (i % 2 ? 'absent-plan' : String(plan.plan_key))),
          now,
        },
        { sql: '1', params: [] },
      ),
    );
    const observed = statementRecorder(db, { accounting: store === 'D1' ? 'd1' : 'native' });
    let cursor: PreflightCursor | null = { stage: 'coverage', id: '' },
      pages = 0;
    let final: Awaited<ReturnType<typeof readViewPreflightPage>> | undefined;
    let acknowledged = 0;
    const parts = new Set<string>();
    while (cursor && pages++ < 64) {
      const page = await readViewPreflightPage(observed.db, 'project', cursor);
      if (page.coverage) acknowledged = page.coverage.acknowledged;
      if (page.coverage?.complete) expect(page.nextCursor?.stage).toBe('inventory');
      parts.add(cursor.stage + ':' + (cursor.kind ?? cursor.coverageStage ?? ''));
      cursor = page.nextCursor
        ? decodeViewPreflightCursor('project', encodeViewPreflightCursor('project', page.nextCursor))
        : null;
      final = page;
    }
    await observed.drain();
    expect(cursor, store).toBeNull();
    expect(pages).toBeGreaterThan(12);
    expect(acknowledged).toBe(201);
    expect(final!.inventory?.classes).toContainEqual({ kind: 'prompt', class: 'legacy', n: 201 });
    expect(final!.inventory?.plans.parser_plans).toBe(130);
    expect(final!.inventory?.receipts).toEqual({ named_plans: 150, missing_plans: 75 });
    expect(parts.has('coverage:pins')).toBe(true);
    expect(observed.statements.filter((row) => row.method === 'all').every((row) => (row.rowCount ?? 0) <= 65)).toBe(
      true,
    );
  });
}, 120000);

test('preflight keysets seek existing prompt chronology and session transcript rowid indexes on both stores', async () => {
  await withViewStores(async (db, store) => {
    let sql = '';
    const capture = { ...db, prepare(text: string) { sql = text; return db.prepare(text); } };
    for (const [factory, params, expected] of [
      [preflightCoverage, ['project', 'session', 1, 'prompt', 65, 'mixed'], 'idx_prompt_batches_first'],
      [preflightCoveragePins, ['project', 'session', 1, 65], 'idx_transcripts_session'],
    ] as const) {
      factory(capture);
      const plan = JSON.stringify((await db.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...params).all()).results);
      expect(plan, store).toContain(expected);
      expect(plan, store).not.toMatch(/SCAN (?:prompt_batches|transcripts)\b/);
      expect(plan, store).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    }
    const indexes = (await db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_preflight_%'").all()).results;
    expect(indexes, store).toEqual([]);
  });
}, 60000);
