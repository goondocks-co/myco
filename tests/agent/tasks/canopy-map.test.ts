/**
 * Tests for the canopy-map two-phase task.
 *
 * Coverage:
 *   - Phase 1 gather assembles the prior-map context, canopy entries, and
 *     rules-file fingerprints into a render-phase prompt.
 *   - inputs_hash short-circuit: identical inputs return undefined the
 *     second time (no LLM call, no DB write).
 *   - Diff-refinement: when a prior canopy_maps row exists and inputs
 *     have drifted, the render prompt embeds the prior map verbatim.
 *   - force_cold_start: bypasses both the short-circuit AND the prior-map
 *     embedding even when a row exists.
 *   - Phase 2 finalize: vault_report content is persisted to canopy_maps
 *     via finalizeOnTaskSuccess + the inputs_hash carried on runContext.
 *
 * The Phase 2 LLM round-trip is not exercised end-to-end — that is a
 * harness concern. The test stops at the boundary the executor crosses:
 * insert a fake vault_report row + runContext, call finalizeOnTaskSuccess,
 * verify writeCanopyMap landed.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { writeCanopyMap, readCanopyMap } from '@myco/canopy/map/store.js';
import { resolveCanopyProjectId } from '@myco/canopy/identity.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import { computeInputsHash, MAP_TASK_PROMPT_VERSION } from '@myco/canopy/map/inputs-hash.js';
import {
  buildCanopyMapInstruction,
  buildTaskInstruction,
  CANOPY_MAP_TASK,
  isInstructionRequiredTask,
} from '@myco/agent/instruction-builders.js';
import { finalizeOnTaskSuccess } from '@myco/agent/executor.js';
import { epochSeconds } from '@myco/constants.js';

const TEST_AGENT_ID = 'test-agent';

let projectRoot: string;
let vaultDir: string;
let projectId: string;
let machineId: string;

function setupProject(): void {
  projectRoot = mkdtempSync(join(tmpdir(), 'myco-canopy-map-'));
  vaultDir = join(projectRoot, '.myco');
  mkdirSync(vaultDir, { recursive: true });
  // Pin a deterministic machine id by pre-writing the cache file. Avoids
  // hitting `git config` / network during the test.
  writeFileSync(join(vaultDir, 'machine_id'), 'test_machine_pin', 'utf-8');
  projectId = resolveCanopyProjectId(vaultDir);
  machineId = getMachineId(vaultDir);
}

function teardownProject(): void {
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

function seedDescribed(path: string, contentHash: string, llmDescription: string): void {
  seedCanopyEntry(getDatabase(), {
    project_id: projectId,
    machine_id: machineId,
    path,
    content_hash: contentHash,
    llm_description: llmDescription,
    llm_updated_at: epochSeconds(),
    mechanical_updated_at: epochSeconds(),
  });
}

describe('canopy-map task', () => {
  beforeAll(() => {
    setupTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
    setupProject();
  });

  // -----------------------------------------------------------------------
  // dispatch wiring
  // -----------------------------------------------------------------------

  describe('dispatch wiring', () => {
    it('isInstructionRequiredTask returns true for canopy-map', () => {
      expect(isInstructionRequiredTask(CANOPY_MAP_TASK)).toBe(true);
    });

    it('buildTaskInstruction routes canopy-map to the gather builder', async () => {
      seedDescribed('src/foo.ts', 'h1', 'Foo module.');
      const built = await buildTaskInstruction(CANOPY_MAP_TASK, undefined, undefined, projectRoot);
      expect(built).toBeDefined();
      expect(built!.instruction).toContain('canopy_entries');
      expect(built!.context?.canopy_map_inputs_hash).toBeTruthy();
    });

    it('returns undefined when projectRoot is missing', async () => {
      const built = await buildCanopyMapInstruction(undefined, undefined);
      expect(built).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // gather phase
  // -----------------------------------------------------------------------

  describe('gather phase', () => {
    it('first run produces an instruction with no prior map and a stable inputs_hash', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');
      seedDescribed('src/b.ts', 'bh', 'B module.');
      writeFileSync(join(projectRoot, 'AGENTS.md'), 'rules contents');

      const built = await buildCanopyMapInstruction(undefined, projectRoot);
      expect(built).toBeDefined();
      expect(built!.instruction).toContain('No prior map');
      expect(built!.instruction).toContain('src/a.ts');
      expect(built!.instruction).toContain('AGENTS.md');
      // The instruction must surface the inputs_hash so the test can
      // cross-check the short-circuit gate.
      expect(built!.instruction).toContain(built!.context!.canopy_map_inputs_hash!);

      // Hash matches the pure function applied to the same inputs.
      const expected = computeInputsHash({
        canopyEntries: [
          { path: 'src/a.ts', content_hash: 'ah', llm_description: 'A module.' },
          { path: 'src/b.ts', content_hash: 'bh', llm_description: 'B module.' },
        ],
        rulesFiles: [
          { filename: 'AGENTS.md', content_hash:
              require('node:crypto').createHash('sha256').update('rules contents').digest('hex') },
        ],
        promptVersion: MAP_TASK_PROMPT_VERSION,
      });
      expect(built!.context!.canopy_map_inputs_hash).toBe(expected);
    });

    it('skips when inputs_hash matches the prior canopy_maps row', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');

      const first = await buildCanopyMapInstruction(undefined, projectRoot);
      expect(first).toBeDefined();
      const inputsHash = first!.context!.canopy_map_inputs_hash!;

      // Mimic a successful run that wrote the row.
      writeCanopyMap({
        project_id: projectId,
        machine_id: machineId,
        content: 'previous map',
        inputs_hash: inputsHash,
        token_estimate: 4,
        generated_by_run_id: 'run-1',
      });

      const second = await buildCanopyMapInstruction(undefined, projectRoot);
      expect(second).toBeUndefined();
    });

    it('embeds the prior map when inputs drift (refinement mode)', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');

      const first = await buildCanopyMapInstruction(undefined, projectRoot);
      const firstHash = first!.context!.canopy_map_inputs_hash!;
      writeCanopyMap({
        project_id: projectId,
        machine_id: machineId,
        content: '## prior map\nbody',
        inputs_hash: firstHash,
        token_estimate: 4,
        generated_by_run_id: 'run-1',
      });

      // Drift one entry's content_hash.
      getDatabase().prepare(
        'UPDATE canopy_entries SET content_hash = ? WHERE project_id = ? AND path = ?',
      ).run('ah-v2', projectId, 'src/a.ts');

      const second = await buildCanopyMapInstruction(undefined, projectRoot);
      expect(second).toBeDefined();
      expect(second!.instruction).toContain('Prior map');
      expect(second!.instruction).toContain('## prior map');
      expect(second!.instruction).toContain('body');
      expect(second!.context!.canopy_map_inputs_hash).not.toBe(firstHash);
    });

    it('force_cold_start ignores the prior map even when inputs are unchanged', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');
      const first = await buildCanopyMapInstruction(undefined, projectRoot);
      const inputsHash = first!.context!.canopy_map_inputs_hash!;
      writeCanopyMap({
        project_id: projectId,
        machine_id: machineId,
        content: '## prior map\nshould not appear',
        inputs_hash: inputsHash,
        token_estimate: 4,
        generated_by_run_id: 'run-1',
      });

      // Without force_cold_start, this would short-circuit (returns undefined).
      const second = await buildCanopyMapInstruction({ force_cold_start: true }, projectRoot);
      expect(second).toBeDefined();
      expect(second!.instruction).toContain('No prior map');
      expect(second!.instruction).not.toContain('should not appear');
    });
  });

  // -----------------------------------------------------------------------
  // finalize (Phase 2 persistence boundary)
  // -----------------------------------------------------------------------

  describe('finalizeOnTaskSuccess', () => {
    it('writes the rendered map atomically when the run reports a canopy_map content', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');

      const built = await buildCanopyMapInstruction(undefined, projectRoot);
      const inputsHash = built!.context!.canopy_map_inputs_hash!;

      const runId = 'run-finalize-1';
      // Insert a run row so FK from agent_reports is satisfied.
      getDatabase().prepare(
        `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
      ).run(TEST_AGENT_ID, TEST_AGENT_ID, epochSeconds());
      getDatabase().prepare(
        `INSERT INTO agent_runs
           (id, agent_id, task, instruction, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(runId, TEST_AGENT_ID, CANOPY_MAP_TASK, built!.instruction, 'completed', epochSeconds());

      insertReport({
        run_id: runId,
        agent_id: TEST_AGENT_ID,
        action: 'canopy_map',
        summary: 'initial map',
        details: JSON.stringify({ content: '# Project map\n## Directory skeleton\n- src — core' }),
        created_at: epochSeconds(),
      });

      await finalizeOnTaskSuccess({
        taskName: CANOPY_MAP_TASK,
        agentId: TEST_AGENT_ID,
        runId,
        runContext: { canopy_map_inputs_hash: inputsHash },
        vaultDir,
      });

      const stored = readCanopyMap(projectId, machineId);
      expect(stored).not.toBeNull();
      expect(stored!.content).toContain('## Directory skeleton');
      expect(stored!.inputs_hash).toBe(inputsHash);
      expect(stored!.generated_by_run_id).toBe(runId);
      expect(stored!.token_estimate).toBeGreaterThan(0);
    });

    it('throws when canopy_map_inputs_hash is missing from runContext', async () => {
      const runId = 'run-finalize-2';
      getDatabase().prepare(
        `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
      ).run(TEST_AGENT_ID, TEST_AGENT_ID, epochSeconds());
      getDatabase().prepare(
        `INSERT INTO agent_runs
           (id, agent_id, task, instruction, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(runId, TEST_AGENT_ID, CANOPY_MAP_TASK, '', 'completed', epochSeconds());

      insertReport({
        run_id: runId,
        agent_id: TEST_AGENT_ID,
        action: 'canopy_map',
        summary: 'x',
        details: JSON.stringify({ content: 'x' }),
        created_at: epochSeconds(),
      });

      await expect(
        finalizeOnTaskSuccess({
          taskName: CANOPY_MAP_TASK,
          agentId: TEST_AGENT_ID,
          runId,
          runContext: {},
          vaultDir,
        }),
      ).rejects.toThrow(/canopy_map_inputs_hash/);
    });

    it('throws when no canopy_map report exists', async () => {
      const runId = 'run-finalize-3';
      getDatabase().prepare(
        `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
      ).run(TEST_AGENT_ID, TEST_AGENT_ID, epochSeconds());
      getDatabase().prepare(
        `INSERT INTO agent_runs
           (id, agent_id, task, instruction, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(runId, TEST_AGENT_ID, CANOPY_MAP_TASK, '', 'completed', epochSeconds());

      await expect(
        finalizeOnTaskSuccess({
          taskName: CANOPY_MAP_TASK,
          agentId: TEST_AGENT_ID,
          runId,
          runContext: { canopy_map_inputs_hash: 'h' },
          vaultDir,
        }),
      ).rejects.toThrow(/canopy_map.*report/i);
    });
  });

  // -----------------------------------------------------------------------
  // teardown
  // -----------------------------------------------------------------------

  it.skip('teardown — runs after each test via beforeEach reset', () => {
    teardownProject();
  });
});
