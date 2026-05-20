/**
 * Tests for the agent-config Grove promotion migration pre-flight passes
 * (Tasks 5.2 + 5.3).
 */

import { describe, test, expect } from 'bun:test';
import { readMigrationPlan, validateMigrationPlan, type MigrationPlan } from './agent-config-grove-promotion.js';
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
