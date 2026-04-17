/**
 * Tests for the dry-run interceptor in createVaultTools.
 *
 * Dry-run is the mechanism the eval harness uses to re-run
 * `full-intelligence` against a live vault snapshot without corrupting
 * state. Reads stay live, writes get intercepted: the intent is
 * recorded to `agent_run_write_intents`, a synthetic shape-compatible
 * payload is returned, and downstream tool calls that reference
 * synthetic IDs still work via an in-memory stub-id map.
 *
 * This suite verifies the interceptor end-to-end:
 *   - Id-minting writes (create_spore) record an intent and return a
 *     stub id, never touching the live table.
 *   - vault_resolve_spore stitches stub ids coherently (hit + miss).
 *   - Generic writes (write_digest) record an intent with no row in
 *     digest_extracts or digest_extract_revisions.
 *   - Exempt tools (vault_report, vault_stage_skill) still run for real.
 *   - vault_finalize_skill is blocked entirely in dry-run.
 *   - With dryRun off, every tool behaves as on main (regression).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock embedding before imports
vi.mock('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertCandidate, updateCandidate } from '@myco/db/queries/skill-candidates.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { createVaultTools } from '@myco/agent/tools.js';
import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'test-agent';
const TEST_RUN_ID = 'run-dry-001';

const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(
    id, `agent-${id}`, epochNow(),
  );
}

function createRun(id: string, agentId: string): void {
  insertRun({ id, agent_id: agentId, status: 'running', started_at: epochNow() });
}

function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as SdkMcpToolDefinition<any>;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

function validSkillContent(name: string) {
  return `---\nname: myco:${name}\ndescription: Test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read\n---\n\n# Skill\n\nBody.`;
}

function countRows(table: string, runIdCol: string | null = null): number {
  const db = getDatabase();
  const row = runIdCol
    ? db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${runIdCol} = ?`).get(TEST_RUN_ID) as { c: number }
    : db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return Number(row.c);
}

function listIntents() {
  const db = getDatabase();
  return db.prepare(
    `SELECT tool_name, tool_input, synthetic_output, stub_id
     FROM agent_run_write_intents
     WHERE run_id = ?
     ORDER BY id ASC`,
  ).all(TEST_RUN_ID) as Array<{
    tool_name: string;
    tool_input: string;
    synthetic_output: string;
    stub_id: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Test suite — dry-run ON
// ---------------------------------------------------------------------------

describe('vault tools dry-run interceptor (dryRun: true)', () => {
  let tools: ReturnType<typeof createVaultTools>;
  let tmpDir: string;
  let vaultDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-dry-run-test-'));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);
    tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      projectRoot: tmpDir,
      vaultDir,
      dryRun: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Id-minting write — vault_create_spore
  // -------------------------------------------------------------------------

  describe('vault_create_spore', () => {
    it('returns a stub id, records an intent, does not touch the spores table', async () => {
      const t = findTool(tools, 'vault_create_spore');
      const result = await t.handler({
        observation_type: 'gotcha',
        content: 'dry-run spore body',
        importance: 7,
        tags: ['alpha', 'beta'],
      }, undefined);

      const payload = parseResult(result) as Record<string, unknown>;

      // Synthetic payload echoes args and carries a dry-run stub id.
      expect(typeof payload.id).toBe('string');
      expect((payload.id as string).startsWith('dry-run:')).toBe(true);
      expect(payload.agent_id).toBe(TEST_AGENT_ID);
      expect(payload.observation_type).toBe('gotcha');
      expect(payload.content).toBe('dry-run spore body');
      expect(payload.importance).toBe(7);
      expect(payload.status).toBe('active');

      // Intent row is recorded and parseable.
      const intents = listIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0].tool_name).toBe('vault_create_spore');
      expect(intents[0].stub_id).toBe(payload.id);
      const synthetic = JSON.parse(intents[0].synthetic_output);
      expect(synthetic.id).toBe(payload.id);
      const toolInput = JSON.parse(intents[0].tool_input);
      expect(toolInput.observation_type).toBe('gotcha');

      // No live-table write.
      expect(countRows('spores')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // vault_resolve_spore — stub hit and stub miss
  // -------------------------------------------------------------------------

  describe('vault_resolve_spore', () => {
    it('stitches a prior stub id into a synthetic resolution payload', async () => {
      const create = findTool(tools, 'vault_create_spore');
      const createResult = await create.handler({
        observation_type: 'decision',
        content: 'chained dry-run spore',
      }, undefined);
      const { id: stubSporeId } = parseResult(createResult) as { id: string };

      const resolve = findTool(tools, 'vault_resolve_spore');
      const resolveResult = await resolve.handler({
        spore_id: stubSporeId,
        action: 'archive',
        reason: 'cleanup',
      }, undefined);

      const payload = parseResult(resolveResult) as Record<string, unknown>;
      expect(payload.spore).toBeTruthy();
      expect((payload.spore as { id: string }).id).toBe(stubSporeId);
      expect(typeof payload.resolution_event_id).toBe('string');
      expect((payload.resolution_event_id as string).startsWith('dry-run:')).toBe(true);

      const intents = listIntents();
      expect(intents).toHaveLength(2);
      expect(intents[1].tool_name).toBe('vault_resolve_spore');

      // No live table writes.
      expect(countRows('spores')).toBe(0);
      expect(countRows('resolution_events')).toBe(0);
    });

    it('records an intent and returns a generic ack when the spore_id is not a stub', async () => {
      const resolve = findTool(tools, 'vault_resolve_spore');
      const result = await resolve.handler({
        spore_id: 'not-a-stub-and-not-live',
        action: 'archive',
      }, undefined);

      // No throw. Generic ack shape.
      const payload = parseResult(result) as Record<string, unknown>;
      expect(payload.dryRun).toBe(true);
      expect(payload.tool).toBe('vault_resolve_spore');
      expect(payload.spore_id).toBe('not-a-stub-and-not-live');

      const intents = listIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0].tool_name).toBe('vault_resolve_spore');
      expect(countRows('resolution_events')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Generic write — vault_write_digest
  // -------------------------------------------------------------------------

  describe('vault_write_digest', () => {
    it('records an intent and writes no digest rows', async () => {
      const t = findTool(tools, 'vault_write_digest');
      const result = await t.handler({ tier: 1500, content: '# dry-run digest\n' }, undefined);

      const payload = parseResult(result) as Record<string, unknown>;
      expect(payload.dryRun).toBe(true);
      expect(payload.tool).toBe('vault_write_digest');

      expect(countRows('digest_extracts')).toBe(0);
      expect(countRows('digest_extract_revisions')).toBe(0);

      const intents = listIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0].tool_name).toBe('vault_write_digest');
      expect(intents[0].stub_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Exempt — vault_report (observability)
  // -------------------------------------------------------------------------

  describe('vault_report (exempt)', () => {
    it('still writes a real report row in dry-run mode', async () => {
      const t = findTool(tools, 'vault_report');
      const result = await t.handler({
        action: 'extract',
        summary: 'dry-run self-narration',
      }, undefined);

      // Real payload echoes the inserted row, including a real run_id.
      const payload = parseResult(result) as Record<string, unknown>;
      expect(payload.run_id).toBe(TEST_RUN_ID);
      expect(payload.action).toBe('extract');

      expect(countRows('agent_reports', 'run_id')).toBe(1);

      // No intent recorded for the exempt tool.
      const intents = listIntents().filter((i) => i.tool_name === 'vault_report');
      expect(intents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Exempt — vault_stage_skill (staging is safe / sweepable)
  // -------------------------------------------------------------------------

  describe('vault_stage_skill (exempt)', () => {
    it('still stages to the real filesystem under .myco/staging/skills/', async () => {
      const now = epochNow();
      const candidate = insertCandidate({
        id: crypto.randomUUID(),
        agent_id: TEST_AGENT_ID,
        topic: 'dry-run-exempt-staging',
        rationale: 'test-only candidate for staging exempt check',
        created_at: now,
        updated_at: now,
      });
      updateCandidate(candidate.id, { status: CANDIDATE_STATUS.APPROVED, updated_at: now });

      const t = findTool(tools, 'vault_stage_skill');
      const result = await t.handler({
        candidate_id: candidate.id,
        name: 'dry-run-exempt-skill',
        display_name: 'Dry Run Exempt Skill',
        description: 'Verify staging writes pass through in dry-run',
        content: validSkillContent('dry-run-exempt-skill'),
      }, undefined);

      const payload = parseResult(result) as Record<string, unknown>;
      expect(payload.status).toBe('staged');
      expect(typeof payload.staging_path).toBe('string');

      // Real staging file exists on disk.
      const stagedPath = path.join(vaultDir, 'staging', 'skills', candidate.id, 'SKILL.md');
      expect(fs.existsSync(stagedPath)).toBe(true);

      // No intent recorded for the exempt tool.
      const intents = listIntents().filter((i) => i.tool_name === 'vault_stage_skill');
      expect(intents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Blocked — vault_finalize_skill
  // -------------------------------------------------------------------------

  describe('vault_finalize_skill (blocked)', () => {
    it('returns the dry-run ack and does not promote', async () => {
      const t = findTool(tools, 'vault_finalize_skill');
      const result = await t.handler({ candidate_id: 'any-candidate-id' }, undefined);

      const payload = parseResult(result) as Record<string, unknown>;
      expect(payload.dryRun).toBe(true);
      expect(payload.tool).toBe('vault_finalize_skill');
      expect(payload.reason).toBe('finalize blocked in dry-run');

      // No skill record was inserted.
      expect(countRows('skill_records')).toBe(0);
      expect(countRows('skill_lineage')).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Test suite — dry-run OFF (regression baseline)
// ---------------------------------------------------------------------------

describe('vault tools regression (dryRun: false)', () => {
  let tools: ReturnType<typeof createVaultTools>;
  let sessionId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    cleanTestDb();
    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);

    // Seed a session so vault_create_spore has a valid FK target when used.
    const now = epochNow();
    sessionId = `sess-${Math.random().toString(36).slice(2, 8)}`;
    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID);
  });

  it('vault_create_spore inserts a real spore row and records no intent', async () => {
    const t = findTool(tools, 'vault_create_spore');
    const result = await t.handler({
      observation_type: 'gotcha',
      content: 'real spore body',
      session_id: sessionId,
    }, undefined);
    const payload = parseResult(result) as Record<string, unknown>;
    expect(typeof payload.id).toBe('string');
    expect((payload.id as string).startsWith('dry-run:')).toBe(false);
    expect(countRows('spores')).toBe(1);
    expect(listIntents()).toHaveLength(0);
  });

  it('vault_write_digest inserts a real digest row', async () => {
    const t = findTool(tools, 'vault_write_digest');
    await t.handler({ tier: 1500, content: '# real digest\n' }, undefined);
    expect(countRows('digest_extracts')).toBe(1);
    expect(listIntents()).toHaveLength(0);
  });

  it('vault_state (read) returns a real result and records no intent', async () => {
    const t = findTool(tools, 'vault_state');
    const result = await t.handler({}, undefined);
    const data = parseResult(result);
    expect(data).toBeTruthy();
    expect(listIntents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test suite — JSON.stringify dedupe in the wrapper hot path
// ---------------------------------------------------------------------------

describe('vault tools wrapper JSON.stringify dedupe', () => {
  let dryTools: ReturnType<typeof createVaultTools>;
  let liveTools: ReturnType<typeof createVaultTools>;
  let tmpDir: string;
  let vaultDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stringify-dedupe-'));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);
    dryTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      projectRoot: tmpDir,
      vaultDir,
      dryRun: true,
    });
    liveTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      projectRoot: tmpDir,
      vaultDir,
      dryRun: false,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('non-guarded read (vault_state) does not stringify args in the audit wrapper', async () => {
    // vault_state is a read tool NOT in LOOP_GUARDED_READ_TOOL_NAMES, so
    // the audit wrapper has no reason to build a repeated-read key. Any
    // JSON.stringify observed during the call must come from downstream
    // work (recordTurn/insertTurn), not the wrapper itself.
    const t = findTool(liveTools, 'vault_state');

    const spy = vi.spyOn(JSON, 'stringify');
    const callsFromArgs = (): number => {
      // Count only stringify calls whose first arg matches the tool args
      // shape `{}` — defensive against unrelated DB plumbing stringifying
      // its own rows. The old wrapper would call JSON.stringify({}) once
      // per tool invocation regardless of whether the key was needed.
      return spy.mock.calls.filter((c) => {
        const first = c[0];
        return first !== null
          && typeof first === 'object'
          && !Array.isArray(first)
          && Object.keys(first as object).length === 0;
      }).length;
    };

    try {
      await t.handler({}, undefined);
      // recordTurn stringifies `toolInput` (the args object) exactly
      // once — that's the only legitimate source for a stringify of
      // the empty-object args. Prior to dedupe, the audit wrapper added
      // a second call.
      expect(callsFromArgs()).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('dry-run intercepted write serializes synthetic payload and args once each', async () => {
    // Before dedupe: 5 stringify calls per intercepted write
    //   - audit wrapper: stringify(args) for repeated-read key (even
    //     though writes aren't guarded)
    //   - recordTurn -> insertTurn: stringify(toolInput)
    //   - wrapToolWithDryRun response: stringify(syntheticPayload)
    //   - wrapToolWithDryRun intent: stringify(syntheticPayload) AGAIN
    //   - wrapToolWithDryRun intent: stringify(args ?? {}) AGAIN
    // After dedupe: 3 calls — the wrapToolWithDryRun stringifies each
    // value once and reuses it, and the audit wrapper skips the key for
    // writes (not on LOOP_GUARDED_READ_TOOL_NAMES).
    const t = findTool(dryTools, 'vault_create_spore');

    const spy = vi.spyOn(JSON, 'stringify');
    try {
      const result = await t.handler({
        observation_type: 'gotcha',
        content: 'dedupe-probe',
      }, undefined);
      const totalCalls = spy.mock.calls.length;

      // Functional sanity first — never regress behavior for a perf fix.
      const payload = parseResult(result) as Record<string, unknown>;
      expect((payload.id as string).startsWith('dry-run:')).toBe(true);

      // Upper bound: ≤ 4 stringify calls total (target is 3 — args,
      // syntheticPayload, toolInput in insertTurn). The +1 slack covers
      // incidental stringify calls from unrelated DB plumbing without
      // masking a regression that puts us back near 5.
      expect(totalCalls).toBeLessThanOrEqual(4);
    } finally {
      spy.mockRestore();
    }
  });
});
