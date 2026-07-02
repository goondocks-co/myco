/**
 * Tests for the semantic-check wrapper in createVaultTools.
 *
 * Verifies: the wrapper only applies to destructiveHint tools, only when
 * enabled + not already dry-run-intercepted (there is no tool-specific
 * exemption list — see design spec §2.1); a 'flag' verdict blocks the
 * real handler and throws; an 'ok' verdict lets the real handler run;
 * the flagged intent is recorded with classifier fields set; the
 * classifier's reasoningLevel is threaded through rather than hardcoded;
 * and the classifier is correctly applied to
 * vault_skill_survey_apply_reconciliation, the real third
 * destructiveHint tool (not vault_finalize_skill).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

const mockClassify = mock(async () => ({ verdict: 'ok' as const, reason: null }));
mock.module('@myco/agent/write-classifier.js', () => ({ classifyWriteIntent: mockClassify }));

// Mocked (rather than relying on the real DB-backed notify()) so the
// identical-retry / cap tests can assert an EXACT call count without the
// 5-minute in-memory dedup window in notifications/notify.ts making a
// "no second notification" assertion ambiguous between "wrapper correctly
// skipped it" and "notify()'s own dedup silently suppressed it".
const mockNotify = mock((..._args: unknown[]) => 'notification-id');
mock.module('@myco/notifications/notify.js', () => ({ notify: mockNotify }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { getDatabase } from '@myco/db/client.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { createVaultTools } from '@myco/agent/tools.js';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';

const TEST_AGENT_ID = 'test-agent-sc';
const TEST_RUN_ID = 'run-sc-001';
const TEST_SESSION_ID = 'session-sc-001';
const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): void {
  getDatabase().prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(id, `agent-${id}`, epochNow());
}
function createRun(id: string, agentId: string): void {
  insertRun({ id, agent_id: agentId, status: 'running', started_at: epochNow() });
}
function createSession(id: string): void {
  const now = epochNow();
  upsertSession({
    id,
    project_id: null,
    agent: 'claude-code',
    started_at: now - 100,
    ended_at: now - 50,
    status: 'completed',
    title: 'Semantic check test session',
    summary: 'Fixture session for semantic-check batch seeding.',
    created_at: now - 100,
    machine_id: 'test-machine',
  });
}
function seedBatch() {
  return insertBatch({
    session_id: TEST_SESSION_ID,
    prompt_number: 1,
    user_prompt: 'do the thing',
    response_summary: 'did the thing',
    started_at: epochNow(),
    ended_at: epochNow(),
    created_at: epochNow(),
    machine_id: 'test-machine',
  });
}
function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}
function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}
function listIntents() {
  return getDatabase().prepare(
    `SELECT tool_name, classifier_verdict, classifier_reason FROM agent_run_write_intents WHERE run_id = ? ORDER BY id ASC`,
  ).all(TEST_RUN_ID) as Array<{ tool_name: string; classifier_verdict: string | null; classifier_reason: string | null }>;
}

describe('semantic write check', () => {
  let tmpDir: string;
  let vaultDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    cleanTestDb();
    mockClassify.mockClear();
    mockNotify.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-semantic-check-test-'));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    ensureProjectManifest(vaultDir, { projectName: 'semantic-check-test' });
    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);
    createSession(TEST_SESSION_ID);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lets the real write through on an "ok" verdict and does not record a flag', async () => {
    mockClassify.mockImplementation(async () => ({ verdict: 'ok', reason: null }));

    const batch = seedBatch();
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    const result = await markProcessed.handler({ batch_id: batch.id }, undefined);
    const payload = parseResult(result) as Record<string, unknown>;

    expect(payload.id).toBe(batch.id);
    expect(mockClassify).toHaveBeenCalledTimes(1);
    const classifyArgs = mockClassify.mock.calls[0][0] as { reasoningLevel?: string };
    expect(classifyArgs.reasoningLevel).toBe('low');

    const intents = listIntents();
    expect(intents).toHaveLength(0); // ok verdicts are not logged as write intents (only flags are)
  });

  it('applies the classifier to vault_skill_survey_apply_reconciliation — the real third destructiveHint tool (not vault_finalize_skill)', async () => {
    // vault_skill_survey_apply_reconciliation requires a validated
    // reconciliation-plan state row keyed by run_id before it will do
    // anything; without it, the tool returns an error payload rather than
    // throwing, and the classifier still runs beforehand regardless of
    // what the real handler ends up doing. This test only asserts the
    // classifier is invoked for this tool once semanticCheckEnabled is on
    // — it does not exercise the full skill-survey reconciliation flow
    // (that is covered by skill-tools' own tests).
    mockClassify.mockImplementation(async () => ({ verdict: 'ok', reason: null }));

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: {
        name: 'persist-decisions',
        promptExcerpt: 'Call vault_skill_survey_apply_reconciliation once. This is the only write path for this phase.',
      },
    });

    const applyReconciliation = findTool(tools, 'vault_skill_survey_apply_reconciliation');
    await applyReconciliation.handler({}, undefined);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    const classifyArgs = mockClassify.mock.calls[0][0] as { toolName?: string };
    expect(classifyArgs.toolName).toBe('vault_skill_survey_apply_reconciliation');
  });

  it('blocks the real write and throws on a "flag" verdict, recording the flagged intent', async () => {
    mockClassify.mockImplementation(async () => ({
      verdict: 'flag',
      reason: 'batch_id does not appear in this phase\'s declared scope',
    }));

    const batch = seedBatch();
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    await expect(markProcessed.handler({ batch_id: batch.id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);

    const intents = listIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0].tool_name).toBe('vault_mark_processed');
    expect(intents[0].classifier_verdict).toBe('flag');
    expect(intents[0].classifier_reason).toBe('batch_id does not appear in this phase\'s declared scope');

    // The real write must NOT have happened — markBatchProcessed sets
    // the `processed` column to 1 (PROCESSED_FLAG); it must still be
    // unset/0 after a flagged, blocked call.
    const row = getDatabase().prepare(`SELECT processed FROM prompt_batches WHERE id = ?`).get(batch.id) as { processed: number };
    expect(row.processed).not.toBe(1);
  });

  it('never leaks the classifier\'s verbatim reason into the error returned to the model — only tool + phase name', async () => {
    // Security hardening: the message thrown from wrapToolWithSemanticCheck
    // is returned to the calling MODEL as the tool result (the SDK
    // converts a handler throw into an isError tool result, not a JS
    // exception the model never sees). Handing a probing model the exact
    // classifier reason tells it precisely how to rephrase its next
    // attempt. The reason must still land on every operator-facing
    // surface — write-intent row, notification, accumulator — just not in
    // the text that reaches the model.
    const secretReason = 'batch_id 999999 targets a different project than this phase is scoped to';
    mockClassify.mockImplementation(async () => ({ verdict: 'flag', reason: secretReason }));

    const batch = seedBatch();
    const flaggedWritesAccumulator: Array<{ toolName: string; reason: string | null; classifierTokens?: number }> = [];
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
      flaggedWritesAccumulator,
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');

    let thrownMessage: string | undefined;
    try {
      await markProcessed.handler({ batch_id: batch.id }, undefined);
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(thrownMessage).toBeDefined();
    expect(thrownMessage).not.toContain(secretReason);
    expect(thrownMessage).toContain('vault_mark_processed');
    expect(thrownMessage).toContain('cleanup');
    expect(thrownMessage).toMatch(/will not succeed on retry/i);

    // The real reason still reaches every operator-facing surface.
    const intents = listIntents();
    expect(intents[0].classifier_reason).toBe(secretReason);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][1]).toMatchObject({ message: secretReason });
    expect(flaggedWritesAccumulator[0].reason).toBe(secretReason);
  });

  it('records a flag into flaggedWritesAccumulator, including classifier token usage', async () => {
    // I2 + C2 wiring: the wrapper folds classifyWriteIntent's usage into
    // the accumulator record it pushes, so executePhase's failure log
    // (phase-loop.ts) can report classifier spend without a separate
    // cost-fold.
    mockClassify.mockImplementation(async () => ({
      verdict: 'flag',
      reason: 'batch_id does not appear in this phase\'s declared scope',
      usage: { requests: 1, inputTokens: 150, outputTokens: 10, totalTokens: 160 },
    }));

    const batch = seedBatch();
    const flaggedWritesAccumulator: Array<{ toolName: string; reason: string | null; classifierTokens?: number }> = [];
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
      flaggedWritesAccumulator,
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    await expect(markProcessed.handler({ batch_id: batch.id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);

    expect(flaggedWritesAccumulator).toHaveLength(1);
    expect(flaggedWritesAccumulator[0].toolName).toBe('vault_mark_processed');
    expect(flaggedWritesAccumulator[0].reason).toBe('batch_id does not appear in this phase\'s declared scope');
    expect(flaggedWritesAccumulator[0].classifierTokens).toBe(160);
  });

  it('never invokes the classifier when the feature is disabled (default)', async () => {
    const batch = seedBatch();
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      // semanticCheckEnabled omitted -> defaults to false/off
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    await markProcessed.handler({ batch_id: batch.id }, undefined);

    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('never invokes the classifier on non-destructiveHint tools', async () => {
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'extract', promptExcerpt: 'Create spores from unprocessed sessions.' },
    });

    const createSpore = findTool(tools, 'vault_create_spore');
    await createSpore.handler({ observation_type: 'gotcha', content: 'unrelated write' }, undefined);

    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('never invokes the classifier when dryRun is active (dry-run interceptor already short-circuits)', async () => {
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      dryRun: true,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    await markProcessed.handler({ batch_id: 1 }, undefined);

    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('threads a non-default classifierReasoningLevel override into the classifier call', async () => {
    // Regression: classifierReasoningLevel (Task 2b's snapshotted
    // RunOptions.executionOverrides.classifierReasoningLevel) was resolved
    // by the executor but never threaded past EffectiveConfig into the
    // tool surface — every classifier call silently defaulted to 'low'
    // even when a caller explicitly overrode the tier. Proves 'high' rides
    // all the way to the classifyWriteIntent call, not just the default.
    mockClassify.mockImplementation(async () => ({ verdict: 'ok', reason: null }));

    const batch = seedBatch();
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'high',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    await markProcessed.handler({ batch_id: batch.id }, undefined);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    const classifyArgs = mockClassify.mock.calls[0][0] as { reasoningLevel?: string };
    expect(classifyArgs.reasoningLevel).toBe('high');
  });

  it('falls back to the classifier\'s low default when classifierReasoningLevel is absent', async () => {
    mockClassify.mockImplementation(async () => ({ verdict: 'ok', reason: null }));

    const batch = seedBatch();
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      // classifierReasoningLevel omitted -> wrapper falls back to 'low'
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    await markProcessed.handler({ batch_id: batch.id }, undefined);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    const classifyArgs = mockClassify.mock.calls[0][0] as { reasoningLevel?: string };
    expect(classifyArgs.reasoningLevel).toBe('low');
  });

  it('threads the phase provider through to classifyWriteIntent', async () => {
    // I1 regression: the wrapper never passed `provider` to
    // classifyWriteIntent, so a provider-override setup (Ollama/custom
    // baseURL) made the classifier build its harness call against the
    // DEFAULT provider env instead of the phase's actual provider.
    mockClassify.mockImplementation(async () => ({ verdict: 'ok', reason: null }));

    const batch = seedBatch();
    const provider = { type: 'ollama' as const, baseUrl: 'http://localhost:11434', model: 'llama3' };
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      provider,
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    await markProcessed.handler({ batch_id: batch.id }, undefined);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    const classifyArgs = mockClassify.mock.calls[0][0] as { provider?: unknown };
    expect(classifyArgs.provider).toEqual(provider);
  });

  it('retrying an identical blocked call reuses the cached verdict — one classifier call, one write-intent row, one notification', async () => {
    // C2b regression: without a verdict cache, a model retrying the SAME
    // blocked tool call verbatim pays a fresh classifier call, writes a
    // duplicate write-intent row, and fires a duplicate notification on
    // every attempt.
    mockClassify.mockImplementation(async () => ({
      verdict: 'flag',
      reason: 'batch_id does not appear in this phase\'s declared scope',
    }));

    const batch = seedBatch();
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');

    await expect(markProcessed.handler({ batch_id: batch.id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);
    await expect(markProcessed.handler({ batch_id: batch.id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);
    await expect(markProcessed.handler({ batch_id: batch.id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);

    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);

    const intents = listIntents();
    expect(intents).toHaveLength(1);
    expect(intents[0].tool_name).toBe('vault_mark_processed');
    expect(intents[0].classifier_verdict).toBe('flag');
  });

  it('retrying an identical call that was classified "ok" keeps letting the real write through from the cache', async () => {
    mockClassify.mockImplementation(async () => ({ verdict: 'ok', reason: null }));

    const batch = seedBatch();
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');
    await markProcessed.handler({ batch_id: batch.id }, undefined);
    await markProcessed.handler({ batch_id: batch.id }, undefined);

    // The real handler is idempotent (marks the same batch processed
    // twice); what matters here is the classifier is only consulted once.
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it('caps distinct flagged attempts per phase — further distinct calls block without a classifier call', async () => {
    // C2b regression: an unbounded classifier gate lets a probing model
    // burn the phase's entire turn budget trying different args shapes
    // until one slips past the classifier. After
    // SEMANTIC_CHECK_DISTINCT_FLAG_CAP distinct flagged attempts, further
    // distinct destructive calls on the tool must short-circuit to
    // blocked WITHOUT another classifier round-trip.
    mockClassify.mockImplementation(async () => ({
      verdict: 'flag',
      reason: 'scope mismatch',
    }));

    const batches = [seedBatch(), seedBatch(), seedBatch(), seedBatch()];
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');

    // Three DISTINCT args (different batch_id each time) — all consult the
    // classifier and get flagged.
    for (const batch of batches.slice(0, 3)) {
      await expect(markProcessed.handler({ batch_id: batch.id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);
    }
    expect(mockClassify).toHaveBeenCalledTimes(3);

    // A FOURTH distinct call (a new batch_id never seen before) — the cap
    // is reached, so this must block WITHOUT a fourth classifier call. The
    // generic block message applies here too (recordFlagAndThrow is shared
    // by both the classifier-verdict path and this cap short-circuit).
    const fourthBatch = batches[3];
    await expect(markProcessed.handler({ batch_id: fourthBatch.id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);
    expect(mockClassify).toHaveBeenCalledTimes(3);

    const intents = listIntents();
    expect(intents).toHaveLength(4);
  });

  it('does not count "ok" verdicts against the distinct-flag cap — only actual flags', async () => {
    // Regression for the cap's own counting: the cap must track distinct
    // FLAGGED (toolName, args) pairs, not every distinct call the verdict
    // cache has ever seen. An 'ok'-heavy phase interleaved with flags must
    // not exhaust the cap early just because it made several distinct
    // calls.
    const batches = [seedBatch(), seedBatch(), seedBatch(), seedBatch(), seedBatch()];
    let call = 0;
    mockClassify.mockImplementation(async () => {
      call++;
      // Alternate ok/flag: calls 1 and 3 are ok, calls 2 and 4 are flagged.
      return call % 2 === 1
        ? { verdict: 'ok' as const, reason: null }
        : { verdict: 'flag' as const, reason: 'scope mismatch' };
    });

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      projectRoot: tmpDir,
      vaultDir,
      semanticCheckEnabled: true,
      harnessId: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
      classifierReasoningLevel: 'low',
      phasePurpose: { name: 'cleanup', promptExcerpt: 'Mark stale prompt batches as processed.' },
    });

    const markProcessed = findTool(tools, 'vault_mark_processed');

    // batches[0]: ok. batches[1]: flag (1st distinct flag). batches[2]: ok.
    // batches[3]: flag (2nd distinct flag). Only 2 distinct flags so far —
    // well under the cap of 3 — even though 4 distinct calls happened.
    await markProcessed.handler({ batch_id: batches[0].id }, undefined);
    await expect(markProcessed.handler({ batch_id: batches[1].id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);
    await markProcessed.handler({ batch_id: batches[2].id }, undefined);
    await expect(markProcessed.handler({ batch_id: batches[3].id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);
    expect(mockClassify).toHaveBeenCalledTimes(4);

    // A 3rd distinct flag (batches[4], call 5 -> ok per the alternation...
    // force it to flag explicitly to land the 3rd distinct flag).
    mockClassify.mockImplementation(async () => ({ verdict: 'flag' as const, reason: 'scope mismatch' }));
    await expect(markProcessed.handler({ batch_id: batches[4].id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);
    expect(mockClassify).toHaveBeenCalledTimes(5);

    // Cap is now reached (3 distinct flags). A brand-new distinct call
    // must short-circuit without a 6th classifier call.
    const sixthBatch = seedBatch();
    await expect(markProcessed.handler({ batch_id: sixthBatch.id }, undefined)).rejects.toThrow(/blocked by a semantic safety check/i);
    expect(mockClassify).toHaveBeenCalledTimes(5);
  });
});
