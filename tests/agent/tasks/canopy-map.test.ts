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
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { getMachineId } from '@myco/machine-id.js';
import { computeInputsHash, MAP_TASK_PROMPT_VERSION } from '@myco/canopy/map/inputs-hash.js';
import {
  buildCanopyMapInstruction,
  buildCanopyMapInstructionDetailed,
  buildTaskInstruction,
  CANOPY_MAP_TASK,
  gatherCanopyMapContext,
  isInstructionRequiredTask,
} from '@myco/agent/instruction-builders.js';
import { finalizeOnTaskSuccess } from '@myco/agent/executor.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { BUNDLED_AGENT_TASKS } from '@myco/agent/definitions.generated.js';
import { epochSeconds } from '@myco/constants.js';

import { TEST_REQUEST_CONTEXT, makeTestRequestContext } from '../../helpers/request-context';
function makeConfig(overrides: { canopyEnabled?: boolean } = {}): MycoConfig {
  const enabled = overrides.canopyEnabled ?? true;
  // The map builder gates on the Canopy capability master switch
  // (cortex.canopy.enabled), not the per-consumer injection toggle.
  return MycoConfigSchema.parse({
    version: 3,
    cortex: { canopy: { enabled } },
  });
}

const TEST_AGENT_ID = 'test-agent';

let projectRoot: string;
let vaultDir: string;
let mycoHome: string;
let priorMycoHome: string | undefined;
let projectId: string;
let machineId: string;

function setupProject(): void {
  projectRoot = mkdtempSync(join(tmpdir(), 'myco-canopy-map-'));
  vaultDir = join(projectRoot, '.myco');
  mkdirSync(vaultDir, { recursive: true });
  // Pin a deterministic machine id by routing MYCO_HOME at a tmp dir and
  // pre-writing the cache file there. Avoids hitting `git config` /
  // network during the test and avoids touching the real ~/.myco.
  mycoHome = mkdtempSync(join(tmpdir(), 'myco-canopy-map-home-'));
  priorMycoHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  writeFileSync(join(mycoHome, 'machine_id'), 'test_machine_pin', 'utf-8');
  projectId = ensureProjectManifest(vaultDir, { projectName: 'canopy-map-test' }).project.id;
  machineId = getMachineId();
}

function teardownProject(): void {
  if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = priorMycoHome;
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(mycoHome, { recursive: true, force: true }); } catch { /* ignore */ }
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

    it('buildCanopyMapInstructionDetailed surfaces the skip reason for the regenerate path', async () => {
      // Pins the contract the daemon's /canopy/map/regenerate runner relies on:
      // every short-circuit branch must come back as a typed skip rather than
      // collapsing to undefined (which lets the agent run with no instruction
      // and crash in finalizeCanopyMap — the production bug this guards).
      const noRoot = await buildCanopyMapInstructionDetailed(undefined, undefined);
      expect(noRoot).toEqual({ kind: 'skip', reason: 'no_project_root' });

      seedDescribed('src/a.ts', 'ah', 'A module.');
      const disabled = await buildCanopyMapInstructionDetailed(
        undefined,
        projectRoot,
        makeConfig({ canopyEnabled: false }),
      );
      expect(disabled).toEqual({ kind: 'skip', reason: 'canopy_disabled' });

      const built = await buildCanopyMapInstructionDetailed(undefined, projectRoot);
      expect(built.kind).toBe('built');
    });

    it('canopy-map ships with schedule.enabled = true by default', () => {
      const def = BUNDLED_AGENT_TASKS.find(t => t.name === CANOPY_MAP_TASK);
      expect(def).toBeDefined();
      expect(def!.schedule).toBeDefined();
      expect(def!.schedule!.enabled).toBe(true);
      expect(def!.schedule!.intervalSeconds).toBe(21600);
      expect(def!.schedule!.runIn).toEqual(['idle', 'sleep']);
    });
  });

  // -----------------------------------------------------------------------
  // mechanical no-op gates (paired with `schedule.enabled: true`)
  // -----------------------------------------------------------------------

  describe('no-op gates', () => {
    it('skips with reason "canopy_disabled" when the Canopy capability is off', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');
      const ctx = await gatherCanopyMapContext(
        projectRoot,
        false,
        makeConfig({ canopyEnabled: false }),
      );
      expect('skip' in ctx).toBe(true);
      expect(ctx).toEqual({ skip: true, reason: 'canopy_disabled' });
    });

    it('builds even when injection is off, as long as the capability is on', async () => {
      // The map is consumed beyond injection (MCP canopy_map, cortex-brief,
      // the UI) — the per-consumer injection toggle must not starve them.
      seedDescribed('src/a.ts', 'ah', 'A module.');
      const config = MycoConfigSchema.parse({
        version: 3,
        cortex: { canopy: { enabled: true, inject_on_pre_tool_use: false } },
      });
      const ctx = await gatherCanopyMapContext(projectRoot, false, config);
      expect('skip' in ctx).toBe(false);
    });

    it('buildCanopyMapInstruction returns undefined when canopy is disabled', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');
      const built = await buildCanopyMapInstruction(
        undefined,
        projectRoot,
        makeConfig({ canopyEnabled: false }),
      );
      expect(built).toBeUndefined();
    });

    it('skips with reason "no_described_entries" when no rows have llm_description', async () => {
      // Seed an entry without an llm_description — passes mechanical_updated_at
      // but not the described predicate.
      seedCanopyEntry(getDatabase(), {
        project_id: projectId,
        machine_id: machineId,
        path: 'src/undescribed.ts',
        content_hash: 'h',
        llm_description: null,
        llm_updated_at: null,
        mechanical_updated_at: epochSeconds(),
      });

      const ctx = await gatherCanopyMapContext(projectRoot, false, makeConfig());
      expect('skip' in ctx).toBe(true);
      expect(ctx).toEqual({ skip: true, reason: 'no_described_entries' });
    });

    it('canopy-disabled gate fires before the no-described-entries gate', async () => {
      // No rows at all — both gates would skip. The canopy-disabled gate is
      // checked first; ordering matters because it lets users with canopy off
      // avoid even cheap COUNT queries.
      const ctx = await gatherCanopyMapContext(
        projectRoot,
        false,
        makeConfig({ canopyEnabled: false }),
      );
      expect(ctx).toEqual({ skip: true, reason: 'canopy_disabled' });
    });

    it('proceeds normally when canopy is enabled and described rows exist', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');
      const ctx = await gatherCanopyMapContext(projectRoot, false, makeConfig());
      expect('skip' in ctx).toBe(false);
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
        requestContext: {
          projectId: projectId as never,
          projectRoot,
          groveId: null,
          machineId,
          sessionId: null,
          projectVaultDir: vaultDir,
          databasePath: '',
          source: 'explicit',
        },
      });

      const stored = readCanopyMap(projectId, machineId);
      expect(stored).not.toBeNull();
      expect(stored!.content).toContain('## Directory skeleton');
      expect(stored!.inputs_hash).toBe(inputsHash);
      expect(stored!.generated_by_run_id).toBe(runId);
      expect(stored!.token_estimate).toBeGreaterThan(0);
    });

    it('finds project-scoped reports for daemon-internal scheduled runs', async () => {
      seedDescribed('src/a.ts', 'ah', 'A module.');

      const built = await buildCanopyMapInstruction(undefined, projectRoot);
      const inputsHash = built!.context!.canopy_map_inputs_hash!;

      const runId = 'run-finalize-daemon-scope';
      getDatabase().prepare(
        `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
      ).run(TEST_AGENT_ID, TEST_AGENT_ID, epochSeconds());
      getDatabase().prepare(
        `INSERT INTO agent_runs
           (id, project_id, agent_id, task, instruction, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(runId, projectId, TEST_AGENT_ID, CANOPY_MAP_TASK, built!.instruction, 'completed', epochSeconds());

      insertReport({
        run_id: runId,
        project_id: projectId,
        agent_id: TEST_AGENT_ID,
        action: 'canopy_map',
        summary: 'scheduled map',
        details: JSON.stringify({ content: '# Scheduled map\n## Directory skeleton\n- src — core' }),
        created_at: epochSeconds(),
      });

      await finalizeOnTaskSuccess({
        taskName: CANOPY_MAP_TASK,
        agentId: TEST_AGENT_ID,
        runId,
        runContext: { canopy_map_inputs_hash: inputsHash },
        vaultDir,
        requestContext: makeTestRequestContext({
          vaultDir,
          projectId,
          groveId: 'grove_internal_test',
          machineId,
          tenancySource: 'daemon',
        }),
      });

      const stored = readCanopyMap(projectId, machineId);
      expect(stored).not.toBeNull();
      expect(stored!.content).toContain('## Directory skeleton');
      expect(stored!.generated_by_run_id).toBe(runId);
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
      requestContext: TEST_REQUEST_CONTEXT,
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
      requestContext: TEST_REQUEST_CONTEXT,
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
