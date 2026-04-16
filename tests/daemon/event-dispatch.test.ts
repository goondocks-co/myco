import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { createEventDispatcher } from '@myco/daemon/event-dispatch.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { PowerManager } from '@myco/daemon/power.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { countActivities } from '@myco/db/queries/activities.js';

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
    liveConfig: { current: { agent: { summary_batch_interval: 20 } } as never },
    vaultDir,
    reconcileSession: () => {},
    planWatchConfig: { enabled: false, planDirs: [] },
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
    expect(registry.getSession(sessionId)).toBeUndefined();
    expect(getSession(sessionId)).toBeNull();
    expect(countActivities(sessionId)).toBe(0);
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
    expect(registry.getSession(sessionId)).toBeDefined();
    expect(getSession(sessionId)?.agent).toBe('codex');
    expect(countActivities(sessionId)).toBe(1);

    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });
});
