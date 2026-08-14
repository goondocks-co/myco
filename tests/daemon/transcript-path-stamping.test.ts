import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { createEventDispatcher } from '@myco/daemon/event-dispatch.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { PowerManager } from '@myco/daemon/power.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { getSession, upsertSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';

/**
 * `sessions.transcript_path` gates mining: a NULL column means the miner
 * never runs, so lineage stitching, re-enrichment and reconciliation are all
 * silently skipped for that session.
 *
 * Before this was stamped from the event stream, the only writer on a live
 * session was the Stop path — and manifest discovery, the fallback, is
 * attempted once per session per process. A session registered before its
 * agent had flushed a transcript to disk (the normal state for a freshly
 * forked Claude Code session) kept a NULL path for the rest of its life
 * even though every subsequent event carried the correct absolute path.
 */

function makeHandler() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-transcript-stamp-log-'));
  const logger = new DaemonLogger(logDir, { level: 'debug' });
  const registry = new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} });
  const powerManager = new PowerManager({
    idleThresholdMs: 60_000,
    sleepThresholdMs: 120_000,
    deepSleepThresholdMs: 180_000,
    activeIntervalMs: 60_000,
    sleepIntervalMs: 60_000,
    logger,
    onTick: () => {},
    deepSleepHolder: () => null,
  });
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-transcript-stamp-vault-'));

  const handler = createEventDispatcher({
    registry,
    sessionBuffers: new Map(),
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

  return { handler, logger, vaultDir };
}

describe('transcript_path stamping from the event stream', () => {
  let transcriptDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-transcript-stamp-'));
  });

  /** A Claude Code tool_use event carrying the session's transcript path. */
  function toolEvent(sessionId: string, transcriptPath: string | undefined) {
    return {
      requestContext: TEST_REQUEST_CONTEXT,
      body: {
        type: 'tool_use',
        session_id: sessionId,
        agent: 'claude-code',
        ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
      },
      query: {},
      params: {},
      pathname: '/events',
    };
  }

  it('stamps the path from a tool event, with no Stop and no file on disk yet', async () => {
    const { handler, logger, vaultDir } = makeHandler();
    const sessionId = 'stamp-from-tool-event';
    // Deliberately NOT created on disk: a forked session's transcript does
    // not exist when the fork's first events arrive, which is exactly the
    // case manifest discovery cannot resolve.
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    await handler(toolEvent(sessionId, transcriptPath));

    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)?.transcript_path).toBe(transcriptPath);

    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('does not clobber a path already recorded', async () => {
    const { handler, logger, vaultDir } = makeHandler();
    const sessionId = 'stamp-no-clobber';
    const original = path.join(transcriptDir, `${sessionId}.jsonl`);
    const other = path.join(transcriptDir, 'a-different-file.jsonl');

    await handler(toolEvent(sessionId, original));
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)?.transcript_path).toBe(original);

    // A later event naming a different file must not redirect mining.
    await handler(toolEvent(sessionId, other));
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)?.transcript_path).toBe(original);

    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('leaves a recorded path intact when a later event carries none', async () => {
    const { handler, logger, vaultDir } = makeHandler();
    const sessionId = 'stamp-survives-pathless-event';
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    await handler(toolEvent(sessionId, transcriptPath));
    await handler(toolEvent(sessionId, undefined));

    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)?.transcript_path).toBe(transcriptPath);

    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('fills a NULL path on an already-registered session from a later event', async () => {
    const { handler, logger, vaultDir } = makeHandler();
    const sessionId = 'stamp-fills-later';
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    // The reported failure shape: SessionStart registered the session while
    // its transcript had no path recorded, so manifest discovery — attempted
    // once per session — found nothing and never retried.
    upsertSession({
      id: sessionId,
      agent: 'claude-code',
      project_id: null,
      project_root: null,
      status: 'active',
      started_at: Math.floor(Date.now() / 1000),
      created_at: Math.floor(Date.now() / 1000),
      machine_id: 'local',
    });
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)?.transcript_path).toBeFalsy();

    // A tool event from that same session carries the path all along.
    await handler(toolEvent(sessionId, transcriptPath));
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)?.transcript_path).toBe(transcriptPath);

    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });
});
