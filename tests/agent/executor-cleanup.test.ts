/**
 * Direct unit tests for the executor's task-failure cleanup hook.
 *
 * The hook fires from runAgent's catch block when a run ends in
 * failure. Testing the full catch path requires the SDK mock + the
 * task registry mock, so the cleanup logic is extracted into
 * `cleanupOnTaskFailure` and tested in isolation here. This keeps
 * the coverage focused on the branching rules (task name match,
 * vaultDir presence, runContext.candidate_id presence) and the
 * filesystem side-effect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { cleanupOnTaskFailure, finalizeOnTaskSuccess } from '@myco/agent/executor.js';
import { CORTEX_INSTRUCTIONS_TASK, SKILL_GENERATE_TASK } from '@myco/agent/instruction-builders.js';
import { CONTENT_HASH_ALGORITHM, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { getCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { insertRun } from '@myco/db/queries/runs.js';
import {
  writeStagedSkill,
  stagingPath,
  stagingRoot,
} from '@myco/agent/tools/skill-staging.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

const NOW = Math.floor(Date.now() / 1000);

describe('cleanupOnTaskFailure', () => {
  let tmpDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-executor-cleanup-')));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes the staging dir for skill-generate when candidate_id is provided', async () => {
    writeStagedSkill(vaultDir, 'cand-cleanup-ok', 'content');
    expect(fs.existsSync(stagingPath(vaultDir, 'cand-cleanup-ok'))).toBe(true);

    await cleanupOnTaskFailure({
      taskName: SKILL_GENERATE_TASK,
      vaultDir,
      runContext: { candidate_id: 'cand-cleanup-ok' },
    });

    expect(fs.existsSync(stagingPath(vaultDir, 'cand-cleanup-ok'))).toBe(false);
  });

  it('leaves sibling staging entries alone', async () => {
    writeStagedSkill(vaultDir, 'cand-a', 'a');
    writeStagedSkill(vaultDir, 'cand-b', 'b');

    await cleanupOnTaskFailure({
      taskName: SKILL_GENERATE_TASK,
      vaultDir,
      runContext: { candidate_id: 'cand-a' },
    });

    expect(fs.existsSync(stagingPath(vaultDir, 'cand-a'))).toBe(false);
    expect(fs.existsSync(stagingPath(vaultDir, 'cand-b'))).toBe(true);
  });

  it('is a no-op when the task is not skill-generate', async () => {
    writeStagedSkill(vaultDir, 'cand-unrelated', 'content');

    await cleanupOnTaskFailure({
      taskName: 'vault-evolve',
      vaultDir,
      runContext: { candidate_id: 'cand-unrelated' },
    });

    // Unrelated task should never touch staging even if a candidate_id
    // happens to be in the runContext.
    expect(fs.existsSync(stagingPath(vaultDir, 'cand-unrelated'))).toBe(true);
  });

  it('is a no-op when the task name is undefined', async () => {
    writeStagedSkill(vaultDir, 'cand-notask', 'content');

    await cleanupOnTaskFailure({
      taskName: undefined,
      vaultDir,
      runContext: { candidate_id: 'cand-notask' },
    });

    expect(fs.existsSync(stagingPath(vaultDir, 'cand-notask'))).toBe(true);
  });

  it('is a no-op when vaultDir is undefined', async () => {
    // Even if the caller forgot to thread vaultDir, the hook must not
    // throw — it just silently skips.
    await expect(
      cleanupOnTaskFailure({
        taskName: SKILL_GENERATE_TASK,
        vaultDir: undefined,
        runContext: { candidate_id: 'cand-novault' },
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when runContext.candidate_id is missing', async () => {
    writeStagedSkill(vaultDir, 'cand-present', 'content');

    await cleanupOnTaskFailure({
      taskName: SKILL_GENERATE_TASK,
      vaultDir,
      runContext: undefined,
    });

    // No candidate_id means we don't know which staging dir to clean,
    // so we leave everything alone and let the periodic GC sweep handle it.
    expect(fs.existsSync(stagingPath(vaultDir, 'cand-present'))).toBe(true);
    // The staging root itself still exists (no directory-level sweep here).
    expect(fs.existsSync(stagingRoot(vaultDir))).toBe(true);
  });

  it('is idempotent when no staging entry exists for the candidate', async () => {
    await expect(
      cleanupOnTaskFailure({
        taskName: SKILL_GENERATE_TASK,
        vaultDir,
        runContext: { candidate_id: 'cand-never-staged' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('finalizeOnTaskSuccess', () => {
  beforeEach(() => {
    setupTestDb();
    cleanTestDb();
    registerAgent({
      id: DEFAULT_AGENT_ID,
      name: 'myco-agent',
      created_at: NOW,
    });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('materializes completed Cortex instructions reports into stored instructions', async () => {
    insertRun({
      id: 'run-cortex-finalize',
      agent_id: DEFAULT_AGENT_ID,
      task: CORTEX_INSTRUCTIONS_TASK,
      status: 'completed',
      started_at: NOW,
      completed_at: NOW,
    });
    insertReport({
      run_id: 'run-cortex-finalize',
      agent_id: DEFAULT_AGENT_ID,
      action: 'cortex_instructions',
      summary: 'stored new instructions',
      details: JSON.stringify({
        content: '## Myco-Enabled Project\n\nMyco provides project memory for this repository.',
      }),
      created_at: NOW,
    });

    await finalizeOnTaskSuccess({
      taskName: CORTEX_INSTRUCTIONS_TASK,
      agentId: DEFAULT_AGENT_ID,
      runId: 'run-cortex-finalize',
      runContext: { cortex_instruction_input_hash: 'hash-cortex-1' },
    });

    expect(getCortexInstructions(DEFAULT_AGENT_ID)).toMatchObject({
      agent_id: DEFAULT_AGENT_ID,
      content: '## Myco-Enabled Project\n\nMyco provides project memory for this repository.',
      input_hash: 'hash-cortex-1',
      source_run_id: 'run-cortex-finalize',
      generated_at: NOW,
    });
  });

  it('falls back to hashing the instruction text when the run context hash is missing', async () => {
    insertRun({
      id: 'run-cortex-fallback',
      agent_id: DEFAULT_AGENT_ID,
      task: CORTEX_INSTRUCTIONS_TASK,
      status: 'completed',
      started_at: NOW,
      completed_at: NOW,
    });
    insertReport({
      run_id: 'run-cortex-fallback',
      agent_id: DEFAULT_AGENT_ID,
      action: 'cortex_instructions',
      summary: 'stored new instructions',
      details: JSON.stringify({
        content: '## Myco-Enabled Project\n\nStored from fallback hash.',
      }),
      created_at: NOW,
    });

    await finalizeOnTaskSuccess({
      taskName: CORTEX_INSTRUCTIONS_TASK,
      agentId: DEFAULT_AGENT_ID,
      runId: 'run-cortex-fallback',
      runContext: undefined,
      instruction: 'instruction-body',
    });

    expect(getCortexInstructions(DEFAULT_AGENT_ID)?.input_hash).toBe(
      crypto.createHash(CONTENT_HASH_ALGORITHM).update('instruction-body').digest('hex'),
    );
  });

  it('is a no-op for unrelated tasks', async () => {
    await expect(
      finalizeOnTaskSuccess({
        taskName: 'vault-evolve',
        agentId: DEFAULT_AGENT_ID,
        runId: 'run-unrelated',
        runContext: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(getCortexInstructions(DEFAULT_AGENT_ID)).toBeNull();
  });
});
