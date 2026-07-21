/**
 * Team Host — host residency-rows ingest (Phase F T2).
 *
 * Covers the route classification + registration seam, the adoption-aware name
 * upgrade, and the NORMATIVE per-table apply matrix: if-newer skips a stale batch
 * both directions, field-merge preserves each side's enrichment, insert-only
 * dedups, publications keep the max generation, the digest_extracts identity
 * upsert, idempotent double-apply per class, the one-transaction rollback + FK
 * self-heal, and the entity_mentions / ensure-agent absent-FK handling.
 *
 * Hermetic: an in-memory DB (`setupTestDb`) for the apply rules, and a fresh
 * `MYCO_HOME` tmpdir for the registry-facing seam + adoption.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { REBUILD_TABLES } from '@myco/db/queries/team-outbox.js';
import {
  RESIDENCY_ALLOWED_TABLES,
  RESIDENCY_APPLY_RULES,
  applyResidencyRows,
  resetResidencyColumnCache,
} from '@myco/db/queries/residency-apply.js';
import { createRoutedResidencyHandler } from '@myco/host/routed-residency.js';
import { classifyRouteStamp, matchRouteRule, ROUTE_RULES } from '@myco/host/routing.js';
import { ROUTED_RESIDENCY_ROWS_PATH } from '@myco/host/residency-journal.js';
import {
  adoptHostedProjectName,
  hostedProjectName,
  maybeRegisterHostedProjectOnIngest,
} from '@myco/host/hosted-projects.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  getRegisteredProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';

const NOW = 1_000_000;

// ---------------------------------------------------------------------------
// (1) Route classification + the frozen-path drift guard
// ---------------------------------------------------------------------------

describe('residency route classification', () => {
  test('the path constant is the frozen literal the drain + registration mount', () => {
    // The main.ts registration writes this as a literal (the completeness scanner
    // only parses literal registerRoute paths); pin the equality here so the two
    // can never drift.
    expect(ROUTED_RESIDENCY_ROWS_PATH).toBe('/routed-capture/residency-rows');
  });

  test('the route is collect-stamped with the Collection capability', () => {
    expect(classifyRouteStamp('POST', ROUTED_RESIDENCY_ROWS_PATH)).toEqual({
      stamp: 'collect',
      capability: 'Collection',
    });
  });

  test('a ROUTE_RULES entry exists and wins matchRouteRule for the path', () => {
    const rule = ROUTE_RULES.find((r) => r.method === 'POST' && r.pattern === ROUTED_RESIDENCY_ROWS_PATH);
    expect(rule).toBeDefined();
    expect(rule!.stamp).toBe('collect');
    expect(matchRouteRule('POST', ROUTED_RESIDENCY_ROWS_PATH)).toBe(rule!);
  });

  test('the daemon mounts the residency handler at ROUTED_RESIDENCY_ROWS_PATH', () => {
    // The ROUTE_RULES entry + drift guard pin the stamp and the literal==constant;
    // this pins that a handler is ACTUALLY registered at the constant (a stale rule
    // with no live route would otherwise pass every check above but never serve).
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'packages', 'myco', 'src', 'daemon', 'main.ts'), 'utf8');
    const match = mainSrc.match(/\.registerRoute\(\s*'POST'\s*,\s*'([^']+)'\s*,\s*createRoutedResidencyHandler/);
    expect(match, 'no registerRoute(POST, <path>, createRoutedResidencyHandler(...)) found in daemon/main.ts').not.toBeNull();
    expect(match![1]).toBe(ROUTED_RESIDENCY_ROWS_PATH);
  });

  test('the apply matrix covers exactly the allow-list', () => {
    // Allow-list = the 18 REBUILD_TABLES + the two sidecars, and every allowed
    // table has a rule (no allow-listed-but-unhandled gap).
    for (const table of REBUILD_TABLES) expect(RESIDENCY_ALLOWED_TABLES.has(table)).toBe(true);
    expect(RESIDENCY_ALLOWED_TABLES.has('entity_mentions')).toBe(true);
    expect(RESIDENCY_ALLOWED_TABLES.has('content_publications')).toBe(true);
    for (const table of RESIDENCY_ALLOWED_TABLES) {
      expect(RESIDENCY_APPLY_RULES[table], `no apply rule for ${table}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) Registration seam + adoption end-to-end (registry-facing, no DB apply)
// ---------------------------------------------------------------------------

describe('residency registration seam + adoption', () => {
  let home: string;
  let servedGrove: GroveRecord;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-seam-'));
    clearGroveRegistryCaches();
    servedGrove = createGrove('Served', home);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    clearGroveRegistryCaches();
  });

  test('the residency route passes the six registration gates on the first batch', () => {
    const projectId = assertGroveProjectId(createProjectId());
    const outcome = maybeRegisterHostedProjectOnIngest({
      method: 'POST',
      pathname: ROUTED_RESIDENCY_ROWS_PATH,
      headers: { 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': projectId },
      servedGroveId: servedGrove.id,
      mycoHome: home,
    });
    expect(outcome.registered).toBe(true);
    // The row lands with the placeholder name (host has not learned the real one yet).
    const row = getRegisteredProjectInGrove(servedGrove.id, projectId, home);
    expect(row!.name).toBe(hostedProjectName(projectId));
  });

  test('adoption upgrades the placeholder to the real name, exactly once', () => {
    const projectId = assertGroveProjectId(createProjectId());
    maybeRegisterHostedProjectOnIngest({
      method: 'POST',
      pathname: ROUTED_RESIDENCY_ROWS_PATH,
      headers: { 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': projectId },
      servedGroveId: servedGrove.id,
      mycoHome: home,
    });
    const created = getRegisteredProjectInGrove(servedGrove.id, projectId, home)!;

    const first = adoptHostedProjectName(servedGrove.id, projectId, 'Real Name', home);
    expect(first.adopted).toBe(true);
    const adopted = getRegisteredProjectInGrove(servedGrove.id, projectId, home)!;
    expect(adopted.name).toBe('Real Name');
    // created_at preserved, synthetic root untouched.
    expect(adopted.created_at).toBe(created.created_at);
    expect(adopted.root).toBe(created.root);

    // A replayed first batch (a lost ack) must NOT re-adopt — the name is real now.
    const second = adoptHostedProjectName(servedGrove.id, projectId, 'Different Name', home);
    expect(second.adopted).toBe(false);
    expect(getRegisteredProjectInGrove(servedGrove.id, projectId, home)!.name).toBe('Real Name');
  });

  test('adoption is a no-op when the row is absent', () => {
    const projectId = assertGroveProjectId(createProjectId());
    expect(adoptHostedProjectName(servedGrove.id, projectId, 'X', home).adopted).toBe(false);
  });

  test('handler applies rows AND adopts the name end-to-end (seam → apply → adopt)', async () => {
    setupTestDb();
    try {
      resetResidencyColumnCache();
      const projectId = assertGroveProjectId(createProjectId());
      // The registration-on-ingest seam runs before the handler in production; do
      // the same here so the placeholder row exists to be adopted.
      maybeRegisterHostedProjectOnIngest({
        method: 'POST',
        pathname: ROUTED_RESIDENCY_ROWS_PATH,
        headers: { 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': projectId },
        servedGroveId: servedGrove.id,
        mycoHome: home,
      });

      const handler = createRoutedResidencyHandler({ mycoHome: home });
      const res = await handler({
        body: {
          table: 'sessions',
          rows: [sessionRow('s_adopt', projectId, { title: 'From Member' })],
          adoption: { project_name: 'Adopted Name' },
        },
        query: {},
        params: {},
        pathname: ROUTED_RESIDENCY_ROWS_PATH,
        requestContext: reqCtx(servedGrove.id, projectId),
      });

      expect(res.status).toBe(200);
      expect((res.body as { ok: boolean; applied: number }).applied).toBe(1);
      // Rows applied to the Grove DB...
      expect(getRow('sessions', 's_adopt')!.title).toBe('From Member');
      // ...and the name adopted in the registry.
      expect(getRegisteredProjectInGrove(servedGrove.id, projectId, home)!.name).toBe('Adopted Name');
    } finally {
      teardownTestDb();
    }
  });

  test('an adoption-only request (empty rows) names the project with no row side effects', async () => {
    // The drain's adoption backstop: a with-history attach with ZERO sync-eligible
    // rows still ships one { table: 'sessions', rows: [], adoption } request so the
    // host learns the name. It must apply nothing and answer { ok, applied: 0 }.
    setupTestDb();
    try {
      resetResidencyColumnCache();
      const projectId = assertGroveProjectId(createProjectId());
      maybeRegisterHostedProjectOnIngest({
        method: 'POST',
        pathname: ROUTED_RESIDENCY_ROWS_PATH,
        headers: { 'x-myco-grove-id': servedGrove.id, 'x-myco-project-id': projectId },
        servedGroveId: servedGrove.id,
        mycoHome: home,
      });

      const handler = createRoutedResidencyHandler({ mycoHome: home });
      const res = await handler({
        body: { table: 'sessions', rows: [], adoption: { project_name: 'Empty History Project' } },
        query: {}, params: {}, pathname: ROUTED_RESIDENCY_ROWS_PATH,
        requestContext: reqCtx(servedGrove.id, projectId),
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, applied: 0 });
      // Name adopted...
      expect(getRegisteredProjectInGrove(servedGrove.id, projectId, home)!.name).toBe('Empty History Project');
      // ...and nothing was written to the Grove DB.
      expect(count('sessions')).toBe(0);
      expect(count('agents')).toBe(0);
    } finally {
      teardownTestDb();
    }
  });
});

// ---------------------------------------------------------------------------
// Row builders + read helpers for the apply-matrix suites
// ---------------------------------------------------------------------------

function reqCtx(groveId: string, projectId: string): MycoRequestContext {
  return {
    groveId,
    projectId: assertGroveProjectId(projectId),
    machineId: 'member-machine',
  } as MycoRequestContext;
}

function sessionRow(id: string, projectId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, agent: 'claude', project_id: projectId, started_at: NOW, status: 'active',
    prompt_count: 0, tool_count: 0, created_at: NOW, machine_id: 'member',
    ...over,
  };
}

function sporeRow(id: string, projectId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, project_id: projectId, agent_id: 'myco-agent', observation_type: 'decision',
    status: 'active', content: 'c', importance: 5, created_at: NOW, updated_at: NOW,
    machine_id: 'member',
    ...over,
  };
}

function getRow(table: string, id: string): Record<string, unknown> | undefined {
  return getDatabase().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

function count(table: string): number {
  return (getDatabase().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

const PROJ = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ---------------------------------------------------------------------------
// (3) Apply-rule matrix
// ---------------------------------------------------------------------------

describe('residency apply matrix', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); resetResidencyColumnCache(); });

  function apply(table: string, rows: Record<string, unknown>[]): number {
    const db = getDatabase();
    return db.transaction(() => applyResidencyRows(db, table, rows).applied)();
  }

  // -- ensure-agent: an agent-referencing row with a novel agent id applies -----
  test('ensure-agent seeds an inert placeholder so a novel agent id never FK-fails', () => {
    expect(count('agents')).toBe(0);
    apply('spores', [sporeRow('sp1', PROJ, { agent_id: 'novel-member-agent' })]);
    expect(getRow('spores', 'sp1')).toBeDefined();
    // The placeholder agent row was created to satisfy the FK — inert: the
    // hosted-residency sentinel source and disabled so nothing runs it.
    const agent = getRow('agents', 'novel-member-agent');
    expect(agent).toBeDefined();
    expect(agent!.source).toBe('hosted-residency');
    expect(agent!.enabled).toBe(0);
  });

  test('a later real registerAgent upgrades the placeholder in place (never stranded)', () => {
    apply('spores', [sporeRow('sp1', PROJ, { agent_id: 'myco-agent' })]);
    expect(getRow('agents', 'myco-agent')!.source).toBe('hosted-residency');
    // The host runs its own intelligence and registers the real agent — the
    // ON CONFLICT DO UPDATE overwrites the placeholder rather than being ignored.
    registerAgent({ id: 'myco-agent', name: 'Myco Agent', source: 'built-in', enabled: 1, created_at: NOW });
    const upgraded = getRow('agents', 'myco-agent')!;
    expect(upgraded.source).toBe('built-in');
    expect(upgraded.enabled).toBe(1);
    expect(upgraded.name).toBe('Myco Agent');
  });

  // -- if-newer via updated_at (both directions) --------------------------------
  test('if-newer skips a stale spore and applies a fresher one', () => {
    apply('spores', [sporeRow('sp1', PROJ, { updated_at: 100, content: 'v1' })]);
    // Older incoming → skipped, row unchanged, still counted as applied.
    expect(apply('spores', [sporeRow('sp1', PROJ, { updated_at: 50, content: 'STALE' })])).toBe(1);
    expect(getRow('spores', 'sp1')!.content).toBe('v1');
    // Newer incoming → replaces.
    apply('spores', [sporeRow('sp1', PROJ, { updated_at: 200, content: 'v2' })]);
    expect(getRow('spores', 'sp1')!.content).toBe('v2');
  });

  test('if-newer falls back to created_at when updated_at is null (never a silent no-op)', () => {
    apply('spores', [sporeRow('sp1', PROJ, { updated_at: null, created_at: 100, content: 'v1' })]);
    // Newer created_at with null updated_at still wins via the fallback.
    apply('spores', [sporeRow('sp1', PROJ, { updated_at: null, created_at: 300, content: 'v2' })]);
    expect(getRow('spores', 'sp1')!.content).toBe('v2');
  });

  test('skill_records breaks an updated_at tie by generation', () => {
    const base = {
      agent_id: 'myco-agent', name: 'n', display_name: 'N', description: 'd', status: 'active',
      path: '/p', created_at: NOW, updated_at: 500,
    };
    apply('skill_records', [{ id: 'sk1', project_id: PROJ, generation: 1, ...base }]);
    // Same updated_at, higher generation → wins.
    apply('skill_records', [{ id: 'sk1', project_id: PROJ, generation: 3, ...base, description: 'gen3' }]);
    expect(getRow('skill_records', 'sk1')!.description).toBe('gen3');
    expect(getRow('skill_records', 'sk1')!.generation).toBe(3);
  });

  test('knowledge_release_state orders by checked_at when updated_at is null', () => {
    const base = {
      project_id: PROJ, machine_id: 'm', namespace: 'ns', record_id: 'r', state: 'released',
      confidence: 'high', created_at: NOW, updated_at: null,
    };
    apply('knowledge_release_state', [{ id: 'kr1', identity_key: 'k1', checked_at: 100, reason: 'first', ...base }]);
    apply('knowledge_release_state', [{ id: 'kr1', identity_key: 'k1', checked_at: 300, reason: 'later', ...base }]);
    expect(getRow('knowledge_release_state', 'kr1')!.reason).toBe('later');
  });

  // -- if-newer via surrogate (entities.last_seen) ------------------------------
  test('entities apply if-newer by last_seen', () => {
    const base = { project_id: PROJ, agent_id: 'myco-agent', type: 'concept', first_seen: NOW, status: 'active' };
    apply('entities', [{ id: 'e1', name: 'v1', last_seen: 200, ...base }]);
    apply('entities', [{ id: 'e1', name: 'STALE', last_seen: 100, ...base }]);
    expect(getRow('entities', 'e1')!.name).toBe('v1');
    apply('entities', [{ id: 'e1', name: 'v2', last_seen: 300, ...base }]);
    expect(getRow('entities', 'e1')!.name).toBe('v2');
  });

  // -- digest_extracts identity upsert ------------------------------------------
  test('digest_extracts upserts by (project_id, agent_id, tier), not by id', () => {
    apply('digest_extracts', [{ id: 'd1', project_id: PROJ, agent_id: 'myco-agent', tier: 5, content: 'v1', generated_at: 100, machine_id: 'm' }]);
    // A DIFFERENT id, same identity, newer generated_at → updates the existing row.
    apply('digest_extracts', [{ id: 'd2', project_id: PROJ, agent_id: 'myco-agent', tier: 5, content: 'v2', generated_at: 200, machine_id: 'm' }]);
    expect(count('digest_extracts')).toBe(1);
    const row = getDatabase().prepare('SELECT content FROM digest_extracts WHERE project_id=? AND agent_id=? AND tier=?').get(PROJ, 'myco-agent', 5) as { content: string };
    expect(row.content).toBe('v2');
    // An older generated_at is skipped.
    apply('digest_extracts', [{ id: 'd3', project_id: PROJ, agent_id: 'myco-agent', tier: 5, content: 'STALE', generated_at: 50, machine_id: 'm' }]);
    expect(count('digest_extracts')).toBe(1);
    const still = getDatabase().prepare('SELECT content FROM digest_extracts WHERE tier=5').get() as { content: string };
    expect(still.content).toBe('v2');
  });

  // -- insert-only (append-only) ------------------------------------------------
  test('insert-only dedups on the PK (graph_edges)', () => {
    const edge = { id: 'ge1', project_id: PROJ, agent_id: 'myco-agent', source_id: 'a', source_type: 'x', target_id: 'b', target_type: 'y', type: 'rel', created_at: NOW, machine_id: 'm' };
    apply('graph_edges', [edge]);
    apply('graph_edges', [{ ...edge, type: 'IGNORED-ON-REPLAY' }]);
    expect(count('graph_edges')).toBe(1);
    // OR IGNORE keeps the original — no update on replay.
    expect(getRow('graph_edges', 'ge1')!.type).toBe('rel');
  });

  // -- field-merge: sessions ----------------------------------------------------
  test('sessions field-merge: enriched host survives a stub incoming', () => {
    apply('sessions', [sessionRow('s1', PROJ, { title: 'Host Title', summary: 'Host Summary', prompt_count: 5, tool_count: 9, ended_at: 200, status: 'completed' })]);
    // Stub incoming: null enrichment, lower counts, in-flight status, null ended_at.
    apply('sessions', [sessionRow('s1', PROJ, { title: null, summary: null, prompt_count: 3, tool_count: 1, ended_at: null, status: 'active' })]);
    const row = getRow('sessions', 's1')!;
    expect(row.title).toBe('Host Title');          // non-null incoming preferred, else keep
    expect(row.summary).toBe('Host Summary');
    expect(row.prompt_count).toBe(5);              // max
    expect(row.tool_count).toBe(9);                // max
    expect(row.ended_at).toBe(200);               // null-safe max keeps the real end
    expect(row.status).toBe('completed');          // terminal never regressed to active
  });

  test('sessions field-merge: enriched incoming fills a stub host row', () => {
    apply('sessions', [sessionRow('s2', PROJ, { title: null, summary: null, prompt_count: 2, ended_at: null, status: 'active' })]);
    apply('sessions', [sessionRow('s2', PROJ, { title: 'Member Title', summary: 'Member Summary', prompt_count: 7, ended_at: 300, status: 'completed' })]);
    const row = getRow('sessions', 's2')!;
    expect(row.title).toBe('Member Title');
    expect(row.summary).toBe('Member Summary');
    expect(row.prompt_count).toBe(7);
    expect(row.ended_at).toBe(300);
    expect(row.status).toBe('completed');          // in-flight promoted to terminal
  });

  // -- field-merge: prompt_batches (self-FK topo-sort) --------------------------
  test('prompt_batches field-merge applies a child-before-parent batch (self-FK topo-sort)', () => {
    apply('sessions', [sessionRow('s1', PROJ)]);
    const parent = { id: 'pb_parent', project_id: PROJ, session_id: 's1', kind: 'initial', origin: 'human', status: 'active', created_at: NOW, machine_id: 'm' };
    const child = { id: 'pb_child', project_id: PROJ, session_id: 's1', parent_prompt_batch_id: 'pb_parent', kind: 'subagent', origin: 'agent', status: 'active', created_at: NOW, machine_id: 'm' };
    // Child listed BEFORE parent — the topo-sort must reorder so the self-FK holds.
    apply('prompt_batches', [child, parent]);
    expect(getRow('prompt_batches', 'pb_parent')).toBeDefined();
    expect(getRow('prompt_batches', 'pb_child')!.parent_prompt_batch_id).toBe('pb_parent');
  });

  test('prompt_batches merge maxes activity_count and never regresses a terminal status', () => {
    apply('sessions', [sessionRow('s1', PROJ)]);
    const base = { id: 'pb1', project_id: PROJ, session_id: 's1', kind: 'initial', origin: 'human', created_at: NOW, machine_id: 'm' };
    apply('prompt_batches', [{ ...base, activity_count: 8, status: 'completed', response_summary: 'done' }]);
    apply('prompt_batches', [{ ...base, activity_count: 2, status: 'active', response_summary: null }]);
    const row = getRow('prompt_batches', 'pb1')!;
    expect(row.activity_count).toBe(8);
    expect(row.status).toBe('completed');
    expect(row.response_summary).toBe('done');
  });

  // -- content_publications: max-generation -------------------------------------
  test('content_publications keeps the max published_generation', () => {
    const pub = (gen: number, by: string) => ({ artifact_kind: 'skill', artifact_id: 'sk1', published_generation: gen, published_at: NOW, published_by: by, machine_id: 'm' });
    apply('content_publications', [pub(2, 'alice')]);
    // A lower generation never regresses the row.
    apply('content_publications', [pub(1, 'bob')]);
    let row = getDatabase().prepare('SELECT * FROM content_publications WHERE artifact_id=?').get('sk1') as Record<string, unknown>;
    expect(row.published_generation).toBe(2);
    expect(row.published_by).toBe('alice');
    // A higher generation raises it and adopts the newer publisher.
    apply('content_publications', [pub(5, 'carol')]);
    row = getDatabase().prepare('SELECT * FROM content_publications WHERE artifact_id=?').get('sk1') as Record<string, unknown>;
    expect(row.published_generation).toBe(5);
    expect(row.published_by).toBe('carol');
  });

  // -- idempotent double-apply per class ----------------------------------------
  test('double-apply is idempotent across every class', () => {
    apply('sessions', [sessionRow('s1', PROJ, { title: 'T' })]);
    const twice = (table: string, rows: Record<string, unknown>[]) => { apply(table, rows); apply(table, rows); };
    twice('spores', [sporeRow('sp1', PROJ)]);
    twice('entities', [{ id: 'e1', project_id: PROJ, agent_id: 'myco-agent', type: 't', name: 'n', first_seen: NOW, last_seen: NOW, status: 'active' }]);
    twice('graph_edges', [{ id: 'ge1', project_id: PROJ, agent_id: 'myco-agent', source_id: 'a', source_type: 'x', target_id: 'b', target_type: 'y', type: 'r', created_at: NOW, machine_id: 'm' }]);
    twice('digest_extracts', [{ id: 'd1', project_id: PROJ, agent_id: 'myco-agent', tier: 1, content: 'c', generated_at: NOW, machine_id: 'm' }]);
    twice('content_publications', [{ artifact_kind: 'skill', artifact_id: 'sk1', published_generation: 1, published_at: NOW, published_by: 'a', machine_id: 'm' }]);
    expect(count('spores')).toBe(1);
    expect(count('entities')).toBe(1);
    expect(count('graph_edges')).toBe(1);
    expect(count('digest_extracts')).toBe(1);
    expect(count('content_publications')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (4) entity_mentions absent-FK skip
// ---------------------------------------------------------------------------

describe('residency entity_mentions absent-FK handling', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); resetResidencyColumnCache(); });

  function apply(table: string, rows: Record<string, unknown>[]): ReturnType<typeof applyResidencyRows> {
    const db = getDatabase();
    return db.transaction(() => applyResidencyRows(db, table, rows))();
  }

  test('an absent-entity mention throws and rolls the WHOLE batch back (no partial, never silently dropped)', () => {
    // e1 exists; the orphan references an absent entity. The batch must not
    // half-apply — the good row rolls back with the orphan (one transaction).
    apply('entities', [{ id: 'e1', project_id: PROJ, agent_id: 'myco-agent', type: 't', name: 'n', first_seen: NOW, last_seen: NOW, status: 'active' }]);
    const good = { project_id: PROJ, entity_id: 'e1', note_id: 'sp1', note_type: 'spore', agent_id: 'myco-agent', machine_id: 'm' };
    const orphan = { project_id: PROJ, entity_id: 'MISSING', note_id: 'sp2', note_type: 'spore', agent_id: 'myco-agent', machine_id: 'm' };

    expect(() => apply('entity_mentions', [good, orphan])).toThrow();
    expect(count('entity_mentions')).toBe(0);
  });

  test('entity_mentions dedups on the four-column key', () => {
    apply('entities', [{ id: 'e1', project_id: PROJ, agent_id: 'myco-agent', type: 't', name: 'n', first_seen: NOW, last_seen: NOW, status: 'active' }]);
    const mention = { project_id: PROJ, entity_id: 'e1', note_id: 'sp1', note_type: 'spore', agent_id: 'myco-agent', machine_id: 'm' };
    apply('entity_mentions', [mention]);
    apply('entity_mentions', [mention]);
    expect(count('entity_mentions')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (5) Handler: validation, one-transaction rollback + FK self-heal
// ---------------------------------------------------------------------------

describe('residency ingest handler', () => {
  let handler: ReturnType<typeof createRoutedResidencyHandler>;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); resetResidencyColumnCache(); handler = createRoutedResidencyHandler({}); });

  async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await handler({
      body, query: {}, params: {}, pathname: ROUTED_RESIDENCY_ROWS_PATH,
      requestContext: reqCtx('grove_x', PROJ),
    });
    return { status: res.status ?? 200, body: res.body as Record<string, unknown> };
  }

  test('an unknown table is refused 400, not applied', async () => {
    const res = await post({ table: 'not_a_table', rows: [{ id: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_table');
  });

  test('a malformed body is refused 400', async () => {
    const res = await post({ table: 'sessions' }); // rows missing
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  test('a happy batch returns { ok, applied }', async () => {
    const res = await post({ table: 'sessions', rows: [sessionRow('s1', PROJ), sessionRow('s2', PROJ)] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, applied: 2 });
  });

  test('a child arriving before its parent table fails whole (rollback) then self-heals after the parent lands', async () => {
    // spores.session_id FKs sessions(id); 's_parent' does not exist yet.
    const orphanSpore = sporeRow('sp1', PROJ, { session_id: 's_parent' });
    const first = await post({ table: 'spores', rows: [orphanSpore] });
    expect(first.status).toBe(409);
    expect(first.body.retryable).toBe(true);
    // The whole batch rolled back — no spore AND no ensure-agent placeholder leaked.
    expect(count('spores')).toBe(0);
    expect(count('agents')).toBe(0);

    // Parent table lands...
    expect((await post({ table: 'sessions', rows: [sessionRow('s_parent', PROJ)] })).status).toBe(200);
    // ...and the identical retried batch now succeeds.
    const retry = await post({ table: 'spores', rows: [orphanSpore] });
    expect(retry.status).toBe(200);
    expect(count('spores')).toBe(1);
  });

  test('an entity_mentions batch before its entity self-heals: 409, nothing written, then 200 after entities land', async () => {
    const mentions = [
      { project_id: PROJ, entity_id: 'e1', note_id: 'sp1', note_type: 'spore', agent_id: 'myco-agent', machine_id: 'm' },
      { project_id: PROJ, entity_id: 'e1', note_id: 'sp2', note_type: 'spore', agent_id: 'myco-agent', machine_id: 'm' },
    ];
    // Mentions arrive before entity e1 exists → retryable 409, whole batch rolled back.
    const first = await post({ table: 'entity_mentions', rows: mentions });
    expect(first.status).toBe(409);
    expect(first.body.retryable).toBe(true);
    expect(count('entity_mentions')).toBe(0);

    // The entities batch lands (entities precede mentions in the send order)...
    expect((await post({ table: 'entities', rows: [{ id: 'e1', project_id: PROJ, agent_id: 'myco-agent', type: 't', name: 'n', first_seen: NOW, last_seen: NOW, status: 'active' }] })).status).toBe(200);
    // ...and the identical retried mentions batch now applies.
    const retry = await post({ table: 'entity_mentions', rows: mentions });
    expect(retry.status).toBe(200);
    expect(count('entity_mentions')).toBe(2);
  });

  test('a genuinely-orphaned mention keeps surfacing as a retryable 409 (never acked-and-lost)', async () => {
    const res = await post({ table: 'entity_mentions', rows: [
      { project_id: PROJ, entity_id: 'never_lands', note_id: 'sp1', note_type: 'spore', agent_id: 'myco-agent', machine_id: 'm' },
    ] });
    expect(res.status).toBe(409);
    expect(count('entity_mentions')).toBe(0);
  });
});
