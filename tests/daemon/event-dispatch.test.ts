import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { createEventDispatcher } from '@myco/daemon/event-dispatch.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { PowerManager } from '@myco/daemon/power.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { countActivities } from '@myco/db/queries/activities.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { listPlansBySession } from '@myco/db/queries/plans.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
function makeHandler() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-event-dispatch-'));
  const logger = new DaemonLogger(logDir, { level: 'debug' });
  const registry = new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} });
  const powerManager = new PowerManager({
    idleThresholdMs: 60_000,
    sleepThresholdMs: 120_000,
    deepSleepThresholdMs: 180_000,
    activeIntervalMs: 60_000,
    sleepIntervalMs: 60_000,
    logger,
  });
  const sessionBuffers = new Map();
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-event-vault-'));

  const handler = createEventDispatcher({
    registry,
    sessionBuffers,
    powerManager,
    logger,
    machineId: 'local',
    liveConfig: { current: {
      agent: { summary_batch_interval: 20 },
      canopy: { exclude: { patterns: [] } },
    } as never },
    vaultDir,
    reconcileSession: () => {},
    planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
    triggerTitleSummary: async () => {},
  });

  return { handler, registry, sessionBuffers, logger, vaultDir };
}

describe('createEventDispatcher', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('drops an orphan Codex tool event with no transcript before auto-registration', async () => {
    const { handler, registry, sessionBuffers, logger, vaultDir } = makeHandler();
    const sessionId = 'codex-orphan-tool-001';

    const res = await handler({
      requestContext: TEST_REQUEST_CONTEXT,
      body: {
        type: 'tool_use',
        session_id: sessionId,
        agent: 'codex',
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
      },
      query: {},
      params: {},
      pathname: '/events',
    });

    expect(res.body).toEqual({ ok: true, ignored: 'ephemeral-sub-invocation' });
    expect(registry.getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeUndefined();
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeNull();
    expect(countActivities(sessionId, ALL_PROJECTS_SCOPE)).toBe(0);
    expect(sessionBuffers.has(sessionId)).toBe(false);

    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('materializes a Codex tool event when a transcript path proves the session is real', async () => {
    const { handler, registry, logger, vaultDir } = makeHandler();
    const sessionId = 'codex-real-tool-001';
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-codex-real-'));
    const transcriptPath = path.join(transcriptDir, `rollout-${sessionId}.jsonl`);

    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'session_meta', source: 'vscode' })}\n`,
      'utf-8',
    );

    const res = await handler({
      requestContext: TEST_REQUEST_CONTEXT,
      body: {
        type: 'tool_use',
        session_id: sessionId,
        agent: 'codex',
        transcript_path: transcriptPath,
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
      },
      query: {},
      params: {},
      pathname: '/events',
    });

    expect(res.body).toEqual({ ok: true });
    expect(registry.getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeDefined();
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)?.agent).toBe('codex');
    expect(countActivities(sessionId, ALL_PROJECTS_SCOPE)).toBe(1);

    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('captures a Claude Ultraplan prompt tag into the session plans table', async () => {
    const { handler, logger, vaultDir } = makeHandler();
    const sessionId = 'claude-ultraplan-prompt-001';
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-claude-ultraplan-'));
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
    const prompt = [
      'Ultraplan approved in browser. Here is the plan:',
      '',
      '<ultraplan>',
      '# Full-Intelligence Efficiency & Tuning Harness',
      '',
      '## Steps',
      '1. Add dry-run harness',
      '2. Add eval matrix',
      '</ultraplan>',
    ].join('\n');

    const res = await handler({
      requestContext: TEST_REQUEST_CONTEXT,
      body: {
        type: 'user_prompt',
        session_id: sessionId,
        agent: 'claude-code',
        transcript_path: transcriptPath,
        prompt,
      },
      query: {},
      params: {},
      pathname: '/events',
    });

    expect(res.body).toMatchObject({ ok: true });

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe(prompt);
    expect(res.body).toMatchObject({ batchId: batches[0].id });

    const plans = listPlansBySession(sessionId, ALL_PROJECTS_SCOPE);
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Full-Intelligence Efficiency & Tuning Harness');
    expect(plans[0].prompt_batch_id).toBe(batches[0].id);
    expect(plans[0].source_path).toBe('transcript:ultraplan');
    expect(plans[0].content).toContain('Add dry-run harness');

    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  describe('DB-backed registry rehydration after daemon restart', () => {
    // Regression: an opencode session registered before a daemon restart used
    // to lose every post-restart event because the in-memory SessionRegistry
    // was empty and the capture gate then dropped the event as an
    // ephemeral-sub-invocation (codex's any_agent transcript_path_missing
    // rule). Events for sessions already persisted in SQLite must bypass the
    // gate — it's a first-sight filter only.

    it('rehydrates registry from DB and captures an opencode event with no transcript_path', async () => {
      const { handler, registry, logger, vaultDir } = makeHandler();
      const sessionId = 'opencode-rehydrate-001';

      // Simulate: session exists in SQLite (registered before daemon restart)
      // but NOT in the in-memory registry (registry was wiped on restart).
      const { upsertSession } = await import('@myco/db/queries/sessions.js');
      upsertSession({
        id: sessionId,
        agent: 'opencode',
        status: 'active',
        started_at: Math.floor(Date.now() / 1000) - 60,
        created_at: Math.floor(Date.now() / 1000) - 60,
        machine_id: 'local',
      });
      expect(registry.getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeUndefined();

      // Opencode events never carry transcript_path. Before the fix this
      // would get dropped by codex's any_agent rule via the capture gate.
      const res = await handler({
      requestContext: TEST_REQUEST_CONTEXT,
        body: {
          type: 'user_prompt',
          session_id: sessionId,
          agent: 'opencode',
          prompt: 'a real prompt that arrived after the daemon restarted',
        },
        query: {},
        headers: {},
        params: {},
        pathname: '/events',
      });

      expect(res.body).toMatchObject({ ok: true });
      expect(res.body).toHaveProperty('batchId');
      expect(registry.getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeDefined();

      const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
      expect(batches).toHaveLength(1);
      expect(batches[0].user_prompt).toBe('a real prompt that arrived after the daemon restarted');

      logger.close();
      fs.rmSync(vaultDir, { recursive: true, force: true });
    });

    it('still gates truly new sessions (no DB row) through capture rules', async () => {
      const { handler, sessionBuffers, logger, vaultDir } = makeHandler();
      const sessionId = 'codex-phantom-new-001';

      // First-sight codex event with no transcript_path — the phantom case
      // the codex manifest rule was written for. Must still drop.
      const res = await handler({
      requestContext: TEST_REQUEST_CONTEXT,
        body: {
          type: 'tool_use',
          session_id: sessionId,
          agent: 'codex',
          tool_name: 'Bash',
          tool_input: {},
          output_preview: '',
        },
        query: {},
        headers: {},
        params: {},
        pathname: '/events',
      });

      expect(res.body).toEqual({ ok: true, ignored: 'ephemeral-sub-invocation' });
      expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeNull();
      expect(sessionBuffers.has(sessionId)).toBe(false);

      logger.close();
      fs.rmSync(vaultDir, { recursive: true, force: true });
    });
  });
});
