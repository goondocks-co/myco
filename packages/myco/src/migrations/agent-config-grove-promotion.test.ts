/**
 * Tests for the agent-config Grove promotion migration pre-flight passes
 * (Tasks 5.2 + 5.3) and write phase (Tasks 5.4 + 5.5).
 */

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  readMigrationPlan,
  validateMigrationPlan,
  writeArchive,
  executeMigration,
  type MigrationPlan,
  type MigrationProjectState,
} from './agent-config-grove-promotion.js';
import { loadGroveConfig, loadMergedConfig, invalidateMergedConfigCache } from '../config/loader.js';
import { withMultiGroveFixture } from '../test-utils/grove-fixture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a valid grove_<32 hex chars> id deterministically for tests. */
function groveId(suffix: string): string {
  const pad = suffix.replace(/[^0-9a-f]/gi, '').toLowerCase();
  const hex = pad.padEnd(32, '0').slice(0, 32);
  return `grove_${hex}`;
}

/** Produce a valid proj_<32 hex chars> id. */
function projId(suffix: string): string {
  const pad = suffix.replace(/[^0-9a-f]/gi, '').toLowerCase();
  const hex = pad.padEnd(32, '0').slice(0, 32);
  return `proj_${hex}`;
}

// ---------------------------------------------------------------------------
// readMigrationPlan
// ---------------------------------------------------------------------------

describe('readMigrationPlan', () => {
  test('returns one MigrationGroveState per Grove with all projects', async () => {
    const g1 = groveId('1');
    const g2 = groveId('2');
    const p_a1 = projId('a1');
    const p_a2 = projId('a2');
    const p_b1 = projId('b1');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g1,
            grove_yaml: {},
            projects: [
              {
                id: p_a1,
                myco: {
                  version: 3,
                  agent: { model: 'claude-sonnet', provider: { type: 'anthropic' } },
                  embedding: { provider: 'openai', model: 'text-embed-3' },
                },
              },
              {
                id: p_a2,
                myco: {
                  version: 3,
                  agent: { model: 'claude-opus' },
                },
              },
            ],
          },
          {
            id: g2,
            grove_yaml: {},
            projects: [
              {
                id: p_b1,
                myco: {
                  version: 3,
                  agent: { model: 'gpt-4' },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        const { plan, errors } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });

        expect(errors).toHaveLength(0);
        expect(plan.groves).toHaveLength(2);

        const grove1State = plan.groves[0]!;
        expect(grove1State.groveId).toBe(g1);
        expect(grove1State.projects).toHaveLength(2);
        // First project's promoted values are lifted.
        expect(grove1State.liftedFromProjectId).toBe(p_a1);
        // Candidate grove should have agent.model from first project.
        expect(grove1State.candidateGroveConfig.agent.model).toBe('claude-sonnet');
        // Second project's promoted values are NOT lifted (first wins).
        const proj2 = grove1State.projects.find((p) => p.projectId === p_a2)!;
        expect(proj2).toBeDefined();
        // Both projects have stripped myco (no agent.model in strippedMyco).
        for (const proj of grove1State.projects) {
          expect((proj.strippedMyco as Record<string, unknown>).agent).toBeUndefined();
          expect((proj.strippedMyco as Record<string, unknown>).embedding).toBeUndefined();
        }

        const grove2State = plan.groves[1]!;
        expect(grove2State.groveId).toBe(g2);
        expect(grove2State.projects).toHaveLength(1);
        expect(grove2State.liftedFromProjectId).toBe(p_b1);
        expect(grove2State.candidateGroveConfig.agent.model).toBe('gpt-4');
      },
    );
  });

  test('Grove-existing values win over lifted first-project values', async () => {
    const g = groveId('aabb');
    const p = projId('cc11');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: { agent: { model: 'pre-existing' } },
            projects: [
              {
                id: p,
                myco: {
                  version: 3,
                  agent: { model: 'lifted-but-ignored', summary_batch_interval: 10 },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        const { plan, errors } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        expect(errors).toHaveLength(0);

        const groveState = plan.groves[0]!;
        // Grove-existing 'pre-existing' wins over project's 'lifted-but-ignored'.
        expect(groveState.candidateGroveConfig.agent.model).toBe('pre-existing');
        // But new paths not in grove (summary_batch_interval) ARE lifted.
        expect(groveState.candidateGroveConfig.agent.summary_batch_interval).toBe(10);
        expect(groveState.liftedFromProjectId).toBe(p);
      },
    );
  });

  test('records parse errors but does not abort', async () => {
    const g = groveId('ff00');
    const p_good = projId('good01');
    const p_bad = projId('bad001');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p_good,
                myco: { version: 3, agent: { model: 'gpt-4o' } },
              },
              {
                id: p_bad,
                // No myco key — we'll corrupt the file after fixture creation.
                myco: { version: 3 },
              },
            ],
          },
        ],
      },
      async (handle) => {
        // Corrupt the bad project's myco.yaml with invalid YAML after fixture setup.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const badVaultDir = handle.groves[0]!.projects[1]!.vaultDir;
        fs.default.writeFileSync(
          path.default.join(badVaultDir, 'myco.yaml'),
          ': invalid: yaml: [unclosed',
          'utf-8',
        );

        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        const { plan, errors } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });

        // At least one error for the bad project.
        expect(errors.length).toBeGreaterThanOrEqual(1);
        const badError = errors.find((e) => e.projectId === p_bad);
        expect(badError).toBeDefined();
        expect(badError!.filePath).toMatch(/myco\.yaml$/);

        // Plan still covers both projects (bad one has empty originalMyco).
        const groveState = plan.groves[0]!;
        expect(groveState.projects).toHaveLength(2);

        // Good project is still processed and lifts its values.
        expect(groveState.liftedFromProjectId).toBe(p_good);
        expect(groveState.candidateGroveConfig.agent.model).toBe('gpt-4o');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// validateMigrationPlan
// ---------------------------------------------------------------------------

describe('validateMigrationPlan', () => {
  test('returns ok=true when candidate configs all parse', async () => {
    const g = groveId('1234');
    const p = projId('abcd');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p,
                myco: {
                  version: 3,
                  agent: { model: 'claude-sonnet', cold_project_threshold_days: 7 },
                  capture: { transcript_paths: ['/tmp/transcripts'] },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        const { plan } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        const result = validateMigrationPlan(plan);

        expect(result.ok).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.plan).toBe(plan);
      },
    );
  });

  test('returns ok=false with error referencing the failing Grove path', async () => {
    const g = groveId('deadbeef');
    const p = projId('cafe00');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [{ id: p, myco: { version: 3 } }],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        const { plan } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });

        // Mutate the candidate to have an invalid value (negative violates min(0)).
        (plan.groves[0]!.candidateGroveConfig.agent as Record<string, unknown>).cold_project_threshold_days = -5;

        const result = validateMigrationPlan(plan);

        expect(result.ok).toBe(false);
        const err = result.errors.find((e) => e.groveId === g);
        expect(err).toBeDefined();
        // The error should reference the grove config path.
        expect(err!.filePath).toContain(g);
      },
    );
  });

  test('reports if stripped local still contains a promoted path', async () => {
    const g = groveId('deadcafe');
    const p = projId('face0000');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [{ id: p, myco: { version: 3 } }],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        const { plan } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });

        // Manually inject a promoted path into strippedLocal to simulate the
        // case where stripping failed or was bypassed.
        const proj = plan.groves[0]!.projects[0]!;
        (proj.strippedLocal as Record<string, unknown>).agent = { model: 'leaked' };

        const result = validateMigrationPlan(plan);

        expect(result.ok).toBe(false);
        const leakError = result.errors.find(
          (e) => e.projectId === p && e.message.includes('agent.model'),
        );
        expect(leakError).toBeDefined();
      },
    );
  });
});

// ---------------------------------------------------------------------------
// writeArchive (Task 5.4)
// ---------------------------------------------------------------------------

describe('writeArchive', () => {
  test('writes archive file with both myco_yaml and local_yaml slices', async () => {
    const g = groveId('arc001');
    const p = projId('arc001');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p,
                myco: {
                  version: 3,
                  agent: { model: 'claude-sonnet', provider: { type: 'anthropic' } },
                },
                local: {
                  agent: { model: 'claude-opus' },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };
        const { plan } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        const project = plan.groves[0]!.projects[0]!;

        const archivePath = writeArchive(project);

        expect(archivePath).not.toBeNull();
        expect(fs.existsSync(archivePath!)).toBe(true);

        const raw = fs.readFileSync(archivePath!, 'utf-8');
        const doc = YAML.parse(raw) as Record<string, unknown>;
        expect(doc.project_id).toBe(p);
        expect(doc.grove_id).toBe(g);
        expect(doc.captured_at).toBeDefined();

        // Both slices present in archive.
        const mycoYaml = doc.myco_yaml as Record<string, unknown>;
        const localYaml = doc.local_yaml as Record<string, unknown>;
        expect((mycoYaml.agent as Record<string, unknown>).model).toBe('claude-sonnet');
        expect((localYaml.agent as Record<string, unknown>).model).toBe('claude-opus');

        // Archive path is inside vaultDir/archive/<timestamp>/
        expect(archivePath!).toContain(path.join(project.vaultDir, 'archive'));
        expect(path.basename(archivePath!)).toBe('agent-config-promotion.yaml');
      },
    );
  });

  test('returns null when both slices are empty', async () => {
    const g = groveId('arc002');
    const p = projId('arc002');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p,
                myco: { version: 3, capture: { transcript_paths: ['/tmp/t'] } },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };
        const { plan } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        const project = plan.groves[0]!.projects[0]!;

        const archivePath = writeArchive(project);
        expect(archivePath).toBeNull();

        // No archive directory created.
        const archiveBase = path.join(project.vaultDir, 'archive');
        expect(fs.existsSync(archiveBase)).toBe(false);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// executeMigration (Task 5.5)
// ---------------------------------------------------------------------------

describe('executeMigration', () => {
  test('persists candidateGroveConfig and strips project files', async () => {
    const g = groveId('exec01');
    const p = projId('exec01');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p,
                myco: {
                  version: 3,
                  agent: { model: 'claude-sonnet', provider: { type: 'anthropic' } },
                  capture: { transcript_paths: ['/tmp/t'] },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };
        const { plan } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        const result = await executeMigration(plan, { mycoHome: handle.mycoHome });

        expect(result.ok).toBe(true);
        expect(result.errors).toHaveLength(0);

        // Grove config now has agent.model from the lifted project.
        const savedGrove = loadGroveConfig(g, handle.mycoHome);
        expect(savedGrove.agent.model).toBe('claude-sonnet');

        // myco.yaml no longer carries agent.* (promoted paths stripped).
        const project = plan.groves[0]!.projects[0]!;
        const mycoRaw = YAML.parse(fs.readFileSync(project.mycoYamlPath, 'utf-8')) as Record<string, unknown>;
        expect(mycoRaw.agent).toBeUndefined();
        // Non-promoted fields survive.
        expect((mycoRaw.capture as Record<string, unknown>).transcript_paths).toEqual(['/tmp/t']);
      },
    );
  });

  test('does not create local.yaml when it did not exist before migration', async () => {
    const g = groveId('exec02');
    const p = projId('exec02');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p,
                // No `local` key — fixture will not write local.yaml.
                myco: {
                  version: 3,
                  agent: { model: 'gpt-4o' },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const vaultDir = handle.groves[0]!.projects[0]!.vaultDir;
        const localYamlPath = path.join(vaultDir, 'local.yaml');

        // Confirm local.yaml does not exist before migration.
        expect(fs.existsSync(localYamlPath)).toBe(false);

        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };
        const { plan } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        const result = await executeMigration(plan, { mycoHome: handle.mycoHome });

        expect(result.ok).toBe(true);
        // local.yaml must not have been created.
        expect(fs.existsSync(localYamlPath)).toBe(false);
      },
    );
  });

  test('idempotent: re-running on already-migrated plan produces no new archive', async () => {
    const g = groveId('exec03');
    const p = projId('exec03');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p,
                myco: {
                  version: 3,
                  agent: { model: 'claude-haiku' },
                  capture: { transcript_paths: ['/tmp/t'] },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        // First run.
        const { plan: plan1 } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        const result1 = await executeMigration(plan1, { mycoHome: handle.mycoHome });
        expect(result1.ok).toBe(true);

        // Count archive dirs after first run.
        const vaultDir = plan1.groves[0]!.projects[0]!.vaultDir;
        const archiveBase = path.join(vaultDir, 'archive');
        const firstRunDirs = fs.existsSync(archiveBase) ? fs.readdirSync(archiveBase) : [];

        // Second run — re-read (promotedSlices will be empty after strip).
        const { plan: plan2 } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        const result2 = await executeMigration(plan2, { mycoHome: handle.mycoHome });
        expect(result2.ok).toBe(true);

        // No new archive dir created on second run.
        const secondRunDirs = fs.existsSync(archiveBase) ? fs.readdirSync(archiveBase) : [];
        expect(secondRunDirs).toHaveLength(firstRunDirs.length);
      },
    );
  });

  test('grove write failure short-circuits that grove but continues to next', async () => {
    const g1 = groveId('exec04a');
    const g2 = groveId('exec04b');
    const p1 = projId('exec04a');
    const p2 = projId('exec04b');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g1,
            grove_yaml: {},
            projects: [
              {
                id: p1,
                myco: { version: 3, agent: { model: 'model-a' } },
              },
            ],
          },
          {
            id: g2,
            grove_yaml: {},
            projects: [
              {
                id: p2,
                myco: { version: 3, agent: { model: 'model-b' } },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };
        const { plan } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });

        // Force a grove write failure on the first grove by making its config
        // path a directory (rename will fail or write will fail).
        const grove1ConfigPath = path.join(handle.groves[0]!.grovePath, 'grove.yaml');
        fs.rmSync(grove1ConfigPath, { force: true });
        fs.mkdirSync(grove1ConfigPath); // a directory where a file is expected

        const result = await executeMigration(plan, { mycoHome: handle.mycoHome });

        // There should be an error for grove 1.
        expect(result.ok).toBe(false);
        const g1Error = result.errors.find((e) => e.groveId === g1);
        expect(g1Error).toBeDefined();
        expect(g1Error!.message).toContain('grove write failed');

        // Grove 2 succeeded — its config should be written.
        const grove2Config = loadGroveConfig(g2, handle.mycoHome);
        expect(grove2Config.agent.model).toBe('model-b');

        // Grove 1's project myco.yaml should NOT have been stripped (skipped).
        const proj1MycoPath = plan.groves[0]!.projects[0]!.mycoYamlPath;
        const proj1Raw = YAML.parse(fs.readFileSync(proj1MycoPath, 'utf-8')) as Record<string, unknown>;
        expect((proj1Raw.agent as Record<string, unknown>).model).toBe('model-a');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: multi-Grove, multi-project (Task 5.7)
//
// Mirrors the MachineState that runAllProjects builds via collectMachineState.
// Verifies the full read → validate → execute pipeline across two Groves.
// ---------------------------------------------------------------------------

describe('end-to-end: full migration pipeline (mirrors runAllProjects)', () => {
  test('promotes agent config from two Groves and strips projects correctly', async () => {
    const g1 = groveId('e2e001a');
    const g2 = groveId('e2e001b');
    const p1a = projId('e2e001a1');
    const p1b = projId('e2e001a2');
    const p2a = projId('e2e001b1');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g1,
            grove_yaml: {},
            projects: [
              {
                id: p1a,
                myco: {
                  version: 3,
                  agent: {
                    model: 'claude-sonnet',
                    provider: { type: 'anthropic' },
                    scheduled_tasks_enabled: true,
                  },
                  embedding: { provider: 'openai', model: 'text-embed-3' },
                  capture: { transcript_paths: ['/tmp/t'] },
                },
              },
              {
                id: p1b,
                myco: {
                  version: 3,
                  agent: { model: 'gpt-4o' },
                },
              },
            ],
          },
          {
            id: g2,
            grove_yaml: { agent: { model: 'pre-existing-model' } },
            projects: [
              {
                id: p2a,
                myco: {
                  version: 3,
                  agent: { model: 'ignored-due-to-grove-existing', cold_project_threshold_days: 30 },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        // Build MachineState the same way collectMachineState does in update.ts.
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        // Step 1: read
        const { plan, errors: readErrors } = await readMigrationPlan(machine, {
          mycoHome: handle.mycoHome,
        });
        expect(readErrors).toHaveLength(0);
        expect(plan.groves).toHaveLength(2);

        // Step 2: validate
        const validated = validateMigrationPlan(plan);
        expect(validated.ok).toBe(true);
        expect(validated.errors).toHaveLength(0);

        // Step 3: execute
        const result = await executeMigration(plan, { mycoHome: handle.mycoHome });
        expect(result.ok).toBe(true);
        expect(result.errors).toHaveLength(0);

        // --- Grove 1 assertions ---
        const grove1Config = loadGroveConfig(g1, handle.mycoHome);
        // First project's model lifted to grove.
        expect(grove1Config.agent.model).toBe('claude-sonnet');
        expect(grove1Config.agent.scheduled_tasks_enabled).toBe(true);
        expect(grove1Config.embedding?.model).toBe('text-embed-3');

        // Project p1a: agent and embedding stripped, capture preserved.
        const p1aMycoRaw = YAML.parse(
          fs.readFileSync(path.join(handle.groves[0]!.projects[0]!.vaultDir, 'myco.yaml'), 'utf-8'),
        ) as Record<string, unknown>;
        expect(p1aMycoRaw.agent).toBeUndefined();
        expect(p1aMycoRaw.embedding).toBeUndefined();
        expect((p1aMycoRaw.capture as Record<string, unknown>).transcript_paths).toEqual(['/tmp/t']);

        // Project p1b: agent stripped.
        const p1bMycoRaw = YAML.parse(
          fs.readFileSync(path.join(handle.groves[0]!.projects[1]!.vaultDir, 'myco.yaml'), 'utf-8'),
        ) as Record<string, unknown>;
        expect(p1bMycoRaw.agent).toBeUndefined();

        // --- Grove 2 assertions ---
        const grove2Config = loadGroveConfig(g2, handle.mycoHome);
        // Grove-existing model wins; project's model was NOT promoted.
        expect(grove2Config.agent.model).toBe('pre-existing-model');
        // But new paths (cold_project_threshold_days) ARE lifted.
        expect(grove2Config.agent.cold_project_threshold_days).toBe(30);

        // Project p2a: agent stripped.
        const p2aMycoRaw = YAML.parse(
          fs.readFileSync(path.join(handle.groves[1]!.projects[0]!.vaultDir, 'myco.yaml'), 'utf-8'),
        ) as Record<string, unknown>;
        expect(p2aMycoRaw.agent).toBeUndefined();
      },
    );
  });

  test('second run is a noop: re-running after migration produces no changes', async () => {
    const g = groveId('e2e002a');
    const p = projId('e2e002a1');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p,
                myco: {
                  version: 3,
                  agent: { model: 'claude-haiku', harness: 'claude-code' },
                  capture: { transcript_paths: ['/tmp/t2'] },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const machine = {
          groves: handle.groves.map((g) => ({
            id: g.id,
            grovePath: g.grovePath,
            projects: g.projects.map((p) => ({ id: p.id, vaultDir: p.vaultDir })),
          })),
        };

        // First run.
        const { plan: plan1 } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        expect(validateMigrationPlan(plan1).ok).toBe(true);
        const result1 = await executeMigration(plan1, { mycoHome: handle.mycoHome });
        expect(result1.ok).toBe(true);

        const mycoYamlPath = path.join(handle.groves[0]!.projects[0]!.vaultDir, 'myco.yaml');
        const contentAfterRun1 = fs.readFileSync(mycoYamlPath, 'utf-8');
        const mtimeAfterRun1 = fs.statSync(mycoYamlPath).mtimeMs;

        // Second run — re-read from disk (projects have no promoted values now).
        const { plan: plan2 } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        expect(validateMigrationPlan(plan2).ok).toBe(true);
        const result2 = await executeMigration(plan2, { mycoHome: handle.mycoHome });
        expect(result2.ok).toBe(true);

        // myco.yaml content unchanged on second run.
        const contentAfterRun2 = fs.readFileSync(mycoYamlPath, 'utf-8');
        expect(contentAfterRun2).toBe(contentAfterRun1);

        // Mtime unchanged (atomic write replaces the file even on noop, but
        // the content comparison above proves idempotency at the data level).
        // We validate the grove config also retained the promoted values.
        const groveConfig = loadGroveConfig(g, handle.mycoHome);
        expect(groveConfig.agent.model).toBe('claude-haiku');
        expect(groveConfig.agent.harness).toBe('claude-code');
        // Suppress unused variable warning.
        void mtimeAfterRun1;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: loader must not erase promoted paths before migration runs
//
// Before the fix, PROJECT_TIER_LEGACY_FIELDS included the 11 promoted paths.
// loadMergedConfig (migrateTiers: true) would strip them from disk before
// runAgentConfigGrovePromotion ran, causing silent data loss. This test
// guards against that regression.
// ---------------------------------------------------------------------------

describe('regression: loader does not erase promoted paths before migration', () => {
  test('lifts agent.provider from myco.yaml even after loader has run', async () => {
    const g = groveId('reg001a');
    const p = projId('reg001a');

    await withMultiGroveFixture(
      {
        groves: [
          {
            id: g,
            grove_yaml: {},
            projects: [
              {
                id: p,
                myco: {
                  version: 3,
                  agent: { provider: { type: 'openrouter' }, model: 'qwen3' },
                  capture: { transcript_paths: ['/tmp/t'] },
                },
              },
            ],
          },
        ],
      },
      async (handle) => {
        const project = handle.groves[0]!.projects[0]!;
        const mycoYamlPath = path.join(project.vaultDir, 'myco.yaml');

        // Step 1: simulate the loader running (as the daemon does on every
        // loadMergedConfig call — migrateTiers: true is the default there).
        invalidateMergedConfigCache(project.vaultDir);
        loadMergedConfig(project.vaultDir, {
          groveId: g,
          mycoHome: handle.mycoHome,
        });

        // Step 2: the on-disk myco.yaml must still carry agent.provider/model
        // because the loader no longer strips promoted paths.
        const rawAfterLoad = YAML.parse(fs.readFileSync(mycoYamlPath, 'utf-8')) as Record<string, unknown>;
        expect((rawAfterLoad.agent as Record<string, unknown>)?.provider).toEqual({ type: 'openrouter' });
        expect((rawAfterLoad.agent as Record<string, unknown>)?.model).toBe('qwen3');

        // Step 3: run the migration.
        const machine = {
          groves: handle.groves.map((grv) => ({
            id: grv.id,
            grovePath: grv.grovePath,
            projects: grv.projects.map((prj) => ({ id: prj.id, vaultDir: prj.vaultDir })),
          })),
        };
        const { plan, errors } = await readMigrationPlan(machine, { mycoHome: handle.mycoHome });
        expect(errors).toHaveLength(0);
        const result = await executeMigration(plan, { mycoHome: handle.mycoHome });
        expect(result.ok).toBe(true);

        // Step 4: grove.yaml now carries agent.provider and agent.model.
        const groveConfig = loadGroveConfig(g, handle.mycoHome);
        expect(groveConfig.agent.provider).toEqual({ type: 'openrouter' });
        expect(groveConfig.agent.model).toBe('qwen3');

        // Step 5: myco.yaml no longer carries the promoted paths.
        const rawAfterMigration = YAML.parse(fs.readFileSync(mycoYamlPath, 'utf-8')) as Record<string, unknown>;
        expect(rawAfterMigration.agent).toBeUndefined();
        // Non-promoted field (capture) survived.
        expect((rawAfterMigration.capture as Record<string, unknown>).transcript_paths).toEqual(['/tmp/t']);
      },
    );
  });
});
