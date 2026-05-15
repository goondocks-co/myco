import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { createReconciler } from '@myco/daemon/reconciliation.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { countActivities } from '@myco/db/queries/activities.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('Buffer reconciliation — duplicate suppression', () => {
  let tmpDir: string;
  let bufferDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-dedup-'));
    bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The exact failure mode from session 019e2bc0 on 2026-05-15: Codex's
  // user_prompt hook fires twice ~3ms apart. The live dispatcher dedups the
  // second one and returns `ignored: 'duplicate'`. The hook CLI sees `ignored`
  // and writes the duplicate to the buffer file "for replay". Without this
  // guard, buffer reconciliation then re-inserts it and the session ends up
  // with two prompt_batches for the same physical prompt (prompt_numbers 47
  // AND 48 in the bug). The duplicates must be suppressed at the replay
  // boundary too.
  it('suppresses duplicate user_prompt events in the buffer (Codex double-fire)', () => {
    const sessionId = 'codex-dup-001';
    seedSession({ id: sessionId, agent: 'codex' });

    const promptText = 'Yes the script is a good idea';
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: promptText, timestamp: '2026-05-15T15:55:07.594Z' }) + '\n' +
      JSON.stringify({ type: 'user_prompt', prompt: promptText, timestamp: '2026-05-15T15:55:07.597Z' }) + '\n',
    );

    const reconciler = createReconciler({ bufferDir, logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession(sessionId);

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe(promptText);
  });

  it('suppresses duplicate tool_use events with identical tool_input', () => {
    const sessionId = 'codex-tool-dup-001';
    seedSession({ id: sessionId, agent: 'codex' });

    const toolEvent = {
      type: 'tool_use',
      tool_name: 'Bash',
      tool_input: { command: 'pwd', description: 'cwd' },
    };
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    fs.writeFileSync(bufferPath,
      // Prompt opens a batch so tool_use has a parent.
      JSON.stringify({ type: 'user_prompt', prompt: 'do the thing', timestamp: '2026-05-15T15:55:00.000Z' }) + '\n' +
      JSON.stringify({ ...toolEvent, timestamp: '2026-05-15T15:55:01.000Z' }) + '\n' +
      JSON.stringify({ ...toolEvent, timestamp: '2026-05-15T15:55:01.020Z' }) + '\n' +
      JSON.stringify({ ...toolEvent, timestamp: '2026-05-15T15:55:01.040Z' }) + '\n',
    );

    const reconciler = createReconciler({ bufferDir, logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession(sessionId);

    expect(countActivities(sessionId, ALL_PROJECTS_SCOPE)).toBe(1);
  });

  // The 10-second window protects against retry storms (which are sub-second
  // bursts) — it must not suppress legitimate same-text turns that pause for
  // a real user think-time between firings.
  it('lets a repeated prompt through if it arrives outside the 10s dedup window', () => {
    const sessionId = 'codex-window-001';
    seedSession({ id: sessionId, agent: 'codex' });

    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'continue', timestamp: '2026-05-15T15:00:00.000Z' }) + '\n' +
      // 15s later — outside the window, treat as a fresh turn.
      JSON.stringify({ type: 'user_prompt', prompt: 'continue', timestamp: '2026-05-15T15:00:15.000Z' }) + '\n',
    );

    const reconciler = createReconciler({ bufferDir, logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession(sessionId);

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches.length).toBe(2);
  });
});
