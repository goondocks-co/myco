/**
 * Tests for the `okf-maintain` scheduled task's scheduling plumbing:
 *
 * - PreConditionSchema registry-membership invariant (every enum member has
 *   a registered scheduler check — an unregistered name means the scheduler
 *   silently never runs the task, `task-scheduler.ts`'s `if (!check) continue;`).
 * - `effectiveTaskScheduleEnabled` capability gating.
 * - `okfMaintainDue` fail-closed precondition behavior.
 * - `computeOkfProbeFingerprint` determinism.
 *
 * Uses the grove-DB fixture pattern from tests/mcp/tools/okf.test.ts:
 * createGrove + registerProjectInGrove + resolveGroveDbPath + a scoped
 * openDatabase/createSchema/withDatabase seed, then `initDatabase` so
 * `getDatabase()` (called ambiently by `okfMaintainDue` and `gather()`)
 * reads the seeded grove DB. Deliberately does NOT use `setupTestDb` — that
 * sets an in-memory singleton that shadows the grove DB and would make the
 * probe read empty tables regardless of what was seeded.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, withDatabase, closeDatabase, initDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { upsertCanopyEntry } from '@myco/canopy/scanner/upsert.js';
import type { CanopyEntry } from '@myco/db/schema.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import {
  resolveLegacyRequestContext,
  projectScopeFromRequestContext,
  type MycoRequestContext,
} from '@myco/grove/request-context.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle } from '@myco/okf/bundle.js';
import { okfMaintainDue, computeOkfProbeFingerprint } from '@myco/okf/schedule.js';
import { effectiveTaskScheduleEnabled } from '@myco/config/capabilities.js';
import { PreConditionSchema } from '@myco/agent/schemas.js';
import { buildPreConditions } from '@myco/daemon/task-scheduling.js';
import { finalizeOnTaskSuccess } from '@myco/agent/executor.js';
import { OKF_MAINTAIN_TASK, OKF_REPORT_ACTION } from '@myco/agent/instruction-builders.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { vi } from '../helpers/vi-shim.js';

const PROJECT_ID = 'proj_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const AGENT_ID = 'claude-code';

// ---------------------------------------------------------------------------
// Registry-membership invariant
// ---------------------------------------------------------------------------

describe('PreConditionSchema registry membership', () => {
  it('every PreConditionSchema member has a buildPreConditions registry key', () => {
    // resolveProjectConfig/taskAgentMap are never invoked by this
    // assertion — it only checks that a key exists for each schema member,
    // not runtime behavior of the functions.
    const registry = buildPreConditions({
      resolveProjectConfig: () => null,
      taskAgentMap: new Map(),
    });
    for (const name of PreConditionSchema.options) {
      expect(registry).toHaveProperty(name);
      expect(typeof registry[name]).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// effectiveTaskScheduleEnabled gating
// ---------------------------------------------------------------------------

describe('effectiveTaskScheduleEnabled for okf-maintain', () => {
  it('is false when the okf config block is absent (capability defaults off)', () => {
    const config = loadMergedConfigFromYaml('version: 3\n');
    expect(effectiveTaskScheduleEnabled(config, 'okf-maintain', true)).toBe(false);
  });

  it('is true when okf.enabled is true', () => {
    const config = loadMergedConfigFromYaml('version: 3\nokf:\n  enabled: true\n');
    expect(effectiveTaskScheduleEnabled(config, 'okf-maintain', true)).toBe(true);
  });

  it('is false when okf.enabled is explicitly false', () => {
    const config = loadMergedConfigFromYaml('version: 3\nokf:\n  enabled: false\n');
    expect(effectiveTaskScheduleEnabled(config, 'okf-maintain', true)).toBe(false);
  });
});

function loadMergedConfigFromYaml(yaml: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-config-'));
  fs.writeFileSync(path.join(dir, 'myco.yaml'), yaml);
  try {
    return loadMergedConfig(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// computeOkfProbeFingerprint determinism
// ---------------------------------------------------------------------------

describe('computeOkfProbeFingerprint', () => {
  const baseInputs = {
    sporeCount: 3,
    maxSporeUpdate: 100,
    canopyCount: 2,
    maxCanopyUpdate: 200,
    conceptCount: 1,
    mapHash: 'map-hash-1',
    include: { spores: true, canopy: true, concepts: true, guides: true },
    sporeStatus: 'active' as const,
  };

  it('is deterministic for identical inputs', () => {
    expect(computeOkfProbeFingerprint(baseInputs)).toBe(computeOkfProbeFingerprint({ ...baseInputs }));
  });

  it('changes when sporeCount changes', () => {
    expect(computeOkfProbeFingerprint(baseInputs)).not.toBe(
      computeOkfProbeFingerprint({ ...baseInputs, sporeCount: 4 }),
    );
  });

  it('changes when include config changes', () => {
    expect(computeOkfProbeFingerprint(baseInputs)).not.toBe(
      computeOkfProbeFingerprint({ ...baseInputs, include: { ...baseInputs.include, guides: false } }),
    );
  });

  it('changes when sporeStatus changes', () => {
    expect(computeOkfProbeFingerprint(baseInputs)).not.toBe(
      computeOkfProbeFingerprint({ ...baseInputs, sporeStatus: 'all' }),
    );
  });

  it('changes when a max-update timestamp changes', () => {
    expect(computeOkfProbeFingerprint(baseInputs)).not.toBe(
      computeOkfProbeFingerprint({ ...baseInputs, maxSporeUpdate: 101 }),
    );
  });
});

// ---------------------------------------------------------------------------
// okfMaintainDue — grove-DB fixture
// ---------------------------------------------------------------------------

describe('okfMaintainDue', () => {
  let rootDir: string;
  let vaultDir: string;
  let projectRoot: string;
  let groveDbPath: string;
  let ctx: MycoRequestContext;

  function writeConfig(extra = ''): void {
    fs.writeFileSync(
      path.join(vaultDir, 'myco.yaml'),
      `version: 3\nokf:\n  enabled: true\n${extra}`,
    );
  }

  function seedGroveDb(seed: () => void): void {
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    createSchema(db);
    withDatabase(db, seed);
    db.close();
    initDatabase(groveDbPath);
  }

  function canopyEntry(overrides: Partial<CanopyEntry> = {}): CanopyEntry {
    return {
      project_id: PROJECT_ID,
      machine_id: 'machine-a',
      path: 'src/index.ts',
      content_hash: 'hash-1',
      size_bytes: 100,
      token_estimate: 50,
      line_count: 10,
      language: 'typescript',
      exports_json: null,
      imports_json: null,
      top_comment: null,
      mechanical_updated_at: 1_783_000_000,
      llm_description: 'A description.',
      llm_updated_at: 1_783_000_000,
      embedded: 0,
      ...overrides,
    } as CanopyEntry;
  }

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-due-')));
    const home = path.join(rootDir, 'home');
    projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    writeConfig();

    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: PROJECT_ID, name: 'okf-due' },
      grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-due', projectRoot, bindingId: 'g' }, home);
    groveDbPath = resolveGroveDbPath(grove.id, home);

    ctx = resolveLegacyRequestContext(vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: grove.id,
      machineId: 'machine-a',
      tenancySource: 'caller',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeDatabase();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const scope = () => projectScopeFromRequestContext(ctx);

  it('is due when no manifest exists yet (never published)', () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
    });
    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(manifest).toBeNull();
    expect(okfMaintainDue(scope(), config, projectRoot, PROJECT_ID, 'machine-a', manifest)).toBe(true);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); bootstraps via a real maintain() run.
  it.skip('is not due when the fingerprint is unchanged since the last publish', async () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
    });
    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    const bundle = new OkfBundle({
      projectRoot,
      vault: new ProjectVault(projectRoot),
      scope: scope(),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config,
      now: () => new Date('2026-07-05T12:00:00Z'),
    });
    await bundle.maintain({
      scope: scope(),
      projectRoot,
      machineId: 'machine-a',
      mode: 'published',
      sporeStatus: 'active',
      acknowledgePublish: true,
    });

    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(manifest?.probe_fingerprint).toBeTruthy();
    expect(okfMaintainDue(scope(), config, projectRoot, PROJECT_ID, 'machine-a', manifest)).toBe(false);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); bootstraps via a real maintain() run.
  it.skip('is due when a spore is added after publish', async () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
    });
    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    const bundle = new OkfBundle({
      projectRoot,
      vault: new ProjectVault(projectRoot),
      scope: scope(),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config,
      now: () => new Date('2026-07-05T12:00:00Z'),
    });
    await bundle.maintain({
      scope: scope(),
      projectRoot,
      machineId: 'machine-a',
      mode: 'published',
      sporeStatus: 'active',
      acknowledgePublish: true,
    });

    insertSpore({ id: 'decision-2', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A second decision.', importance: 5, created_at: 1_783_000_100, machine_id: 'machine-a' });

    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(okfMaintainDue(scope(), config, projectRoot, PROJECT_ID, 'machine-a', manifest)).toBe(true);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); bootstraps via a real maintain() run.
  it.skip('is due when a spore is updated (updated_at bump) after publish', async () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
    });
    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    const bundle = new OkfBundle({
      projectRoot,
      vault: new ProjectVault(projectRoot),
      scope: scope(),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config,
      now: () => new Date('2026-07-05T12:00:00Z'),
    });
    await bundle.maintain({
      scope: scope(),
      projectRoot,
      machineId: 'machine-a',
      mode: 'published',
      sporeStatus: 'active',
      acknowledgePublish: true,
    });

    withDatabase(openDatabase(groveDbPath), () => {
      /* no-op: kept for symmetry, real update below uses the initialized singleton */
    });
    const db = getDatabase();
    db.prepare('UPDATE spores SET updated_at = ? WHERE id = ?').run(1_783_000_500, 'decision-1');

    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(okfMaintainDue(scope(), config, projectRoot, PROJECT_ID, 'machine-a', manifest)).toBe(true);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); bootstraps via a real maintain() run.
  it.skip('is due when the include config changes even if counts are unchanged', async () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
    });
    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    const bundle = new OkfBundle({
      projectRoot,
      vault: new ProjectVault(projectRoot),
      scope: scope(),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config,
      now: () => new Date('2026-07-05T12:00:00Z'),
    });
    await bundle.maintain({
      scope: scope(),
      projectRoot,
      machineId: 'machine-a',
      mode: 'published',
      sporeStatus: 'active',
      acknowledgePublish: true,
    });

    writeConfig('  maintain:\n    include:\n      - spores\n');
    const changedConfig = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(okfMaintainDue(scope(), changedConfig, projectRoot, PROJECT_ID, 'machine-a', manifest)).toBe(true);
  });

  it('is not due when the okf capability is disabled', () => {
    writeConfig();
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: false\n');
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
    });
    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    expect(okfMaintainDue(scope(), config, projectRoot, PROJECT_ID, 'machine-a', null)).toBe(false);
  });

  it('is not due when the configured output path resolves outside the project (external export)', () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
    });
    fs.writeFileSync(
      path.join(vaultDir, 'myco.yaml'),
      'version: 3\nokf:\n  enabled: true\n  maintain:\n    output_path: "../outside"\n',
    );
    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    expect(okfMaintainDue(scope(), config, projectRoot, PROJECT_ID, 'machine-a', null)).toBe(false);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); bootstraps via a real maintain() run.
  it.skip('reflects canopy entry changes when canopy capability is enabled', async () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      const db = getDatabase();
      upsertCanopyEntry(db, canopyEntry());
    });
    fs.writeFileSync(
      path.join(vaultDir, 'myco.yaml'),
      'version: 3\nokf:\n  enabled: true\ncortex:\n  enabled: true\n  canopy:\n    enabled: true\n',
    );
    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    const bundle = new OkfBundle({
      projectRoot,
      vault: new ProjectVault(projectRoot),
      scope: scope(),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config,
      now: () => new Date('2026-07-05T12:00:00Z'),
    });
    await bundle.maintain({
      scope: scope(),
      projectRoot,
      machineId: 'machine-a',
      mode: 'published',
      sporeStatus: 'active',
      acknowledgePublish: true,
    });

    let manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(okfMaintainDue(scope(), config, projectRoot, PROJECT_ID, 'machine-a', manifest)).toBe(false);

    const db = getDatabase();
    upsertCanopyEntry(db, canopyEntry({ path: 'src/other.ts', content_hash: 'hash-2' }));

    manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(okfMaintainDue(scope(), config, projectRoot, PROJECT_ID, 'machine-a', manifest)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// finalizeOkfMaintain (via finalizeOnTaskSuccess) — grove-DB fixture
// ---------------------------------------------------------------------------

describe('finalizeOkfMaintain', () => {
  let rootDir: string;
  let vaultDir: string;
  let projectRoot: string;
  let groveDbPath: string;
  let ctx: MycoRequestContext;

  function seedGroveDb(seed: () => void): void {
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    createSchema(db);
    withDatabase(db, seed);
    db.close();
    initDatabase(groveDbPath);
  }

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-finalize-')));
    const home = path.join(rootDir, 'home');
    projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');

    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: PROJECT_ID, name: 'okf-finalize' },
      grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-finalize', projectRoot, bindingId: 'g' }, home);
    groveDbPath = resolveGroveDbPath(grove.id, home);

    ctx = resolveLegacyRequestContext(vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: grove.id,
      machineId: 'machine-a',
      tenancySource: 'caller',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeDatabase();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); finalizeOkfMaintain calls a real maintain().
  it.skip('publishes the bundle after a successful run with an okf_maintain report', async () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A clean decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
      insertRun({ id: 'run-finalize-1', project_id: PROJECT_ID, agent_id: AGENT_ID, task: OKF_MAINTAIN_TASK, status: 'running', started_at: 1_783_000_000 });
      insertReport({
        run_id: 'run-finalize-1',
        project_id: PROJECT_ID,
        agent_id: AGENT_ID,
        action: OKF_REPORT_ACTION,
        summary: 'Nothing agent-worthy changed.',
        created_at: 1_783_000_000,
      });
    });

    await finalizeOnTaskSuccess({
      taskName: OKF_MAINTAIN_TASK,
      agentId: AGENT_ID,
      runId: 'run-finalize-1',
      runContext: undefined,
      requestContext: ctx,
      vaultDir,
    });

    expect(fs.existsSync(path.join(projectRoot, 'okf/index.md'))).toBe(true);
    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(manifest?.bundle_generation).toBe(1);
    expect(manifest?.last_result).toBe('published');
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); finalizeOkfMaintain calls a real maintain().
  it.skip('settles to not-due after a scheduled publish even with include_undescribed_canopy=true (probe/publish parity)', async () => {
    // Regression: finalizeOkfMaintain must thread includeUndescribedCanopy so
    // the persisted probe_fingerprint matches what okfMaintainDue recomputes.
    // Without it, publish counts described-only canopy while the probe counts
    // all canopy → perpetual "due" storm + the bundle drops undescribed canopy.
    fs.writeFileSync(
      path.join(vaultDir, 'myco.yaml'),
      'version: 3\nokf:\n  enabled: true\n  maintain:\n    include_undescribed_canopy: true\n',
    );
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
      // An UNDESCRIBED canopy row — counted by the probe (flag true) but, before
      // the fix, NOT by the publish path (which defaulted the flag to false).
      upsertCanopyEntry(getDatabase(), {
        project_id: PROJECT_ID, machine_id: 'machine-a', path: 'src/undescribed.ts',
        content_hash: 'hash-u', size_bytes: 100, token_estimate: 50, line_count: 10,
        language: 'typescript', exports_json: null, imports_json: null, top_comment: null,
        mechanical_updated_at: 1_783_000_050, llm_description: null, llm_updated_at: null, embedded: 0,
      } as CanopyEntry);
      insertRun({ id: 'run-undesc', project_id: PROJECT_ID, agent_id: AGENT_ID, task: OKF_MAINTAIN_TASK, status: 'running', started_at: 1_783_000_000 });
      insertReport({ run_id: 'run-undesc', project_id: PROJECT_ID, agent_id: AGENT_ID, action: OKF_REPORT_ACTION, summary: 'ok', created_at: 1_783_000_000 });
    });

    await finalizeOnTaskSuccess({
      taskName: OKF_MAINTAIN_TASK,
      agentId: AGENT_ID,
      runId: 'run-undesc',
      runContext: undefined,
      requestContext: ctx,
      vaultDir,
    });

    const config = loadMergedConfig(vaultDir, { groveId: ctx.groveId ?? undefined });
    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(manifest?.last_result).toBe('published');
    // The undescribed canopy concept IS in the published bundle.
    expect(fs.existsSync(path.join(projectRoot, 'okf/canopy/files/src/undescribed.ts.md'))).toBe(true);
    // And the probe agrees nothing more is due — no perpetual storm.
    expect(okfMaintainDue(projectScopeFromRequestContext(ctx), config, projectRoot, PROJECT_ID, 'machine-a', manifest)).toBe(false);
  });

  it('throws loudly when the run completed without an okf report', async () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertRun({ id: 'run-finalize-2', project_id: PROJECT_ID, agent_id: AGENT_ID, task: OKF_MAINTAIN_TASK, status: 'running', started_at: 1_783_000_000 });
    });

    await expect(
      finalizeOnTaskSuccess({
        taskName: OKF_MAINTAIN_TASK,
        agentId: AGENT_ID,
        runId: 'run-finalize-2',
        runContext: undefined,
        requestContext: ctx,
        vaultDir,
      }),
    ).rejects.toThrow(/okf-maintain completed without an okf report/);

    expect(fs.existsSync(path.join(projectRoot, 'okf'))).toBe(false);
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); finalizeOkfMaintain calls a real maintain()
  // which now throws not_implemented instead of the expected okf_publish_not_acknowledged.
  it.skip('records a clean "publish blocked" outcome and does not throw when findings are unacknowledged', async () => {
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      // Trips the absolute_local_path publish-eligibility finding.
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'Path is /Users/someone/secret-project.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
      insertRun({ id: 'run-finalize-3', project_id: PROJECT_ID, agent_id: AGENT_ID, task: OKF_MAINTAIN_TASK, status: 'running', started_at: 1_783_000_000 });
      insertReport({
        run_id: 'run-finalize-3',
        project_id: PROJECT_ID,
        agent_id: AGENT_ID,
        action: OKF_REPORT_ACTION,
        summary: 'Reviewed changes.',
        created_at: 1_783_000_000,
      });
    });

    await expect(
      finalizeOnTaskSuccess({
        taskName: OKF_MAINTAIN_TASK,
        agentId: AGENT_ID,
        runId: 'run-finalize-3',
        runContext: undefined,
        requestContext: ctx,
        vaultDir,
      }),
    ).resolves.toBeUndefined();

    // Run is NOT failed by this outcome — no bundle published, but no throw either.
    expect(fs.existsSync(path.join(projectRoot, 'okf/index.md'))).toBe(false);
    const manifest = new ProjectVault(projectRoot).readOkfManifest();
    expect(manifest).toBeNull();
  });

  // Phase 2: renderDocuments is stubbed (Task 0.1); finalizeOkfMaintain calls a real maintain().
  it.skip('propagates an OkfError OTHER than okf_publish_not_acknowledged instead of swallowing it', async () => {
    // finalizeOkfMaintain's catch block only special-cases
    // okf_publish_not_acknowledged (clean report + notify, no throw). Every
    // other OkfError — here okf_validation_failed — must fail the run.
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A clean decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
      insertRun({ id: 'run-finalize-4', project_id: PROJECT_ID, agent_id: AGENT_ID, task: OKF_MAINTAIN_TASK, status: 'running', started_at: 1_783_000_000 });
      insertReport({
        run_id: 'run-finalize-4',
        project_id: PROJECT_ID,
        agent_id: AGENT_ID,
        action: OKF_REPORT_ACTION,
        summary: 'Nothing agent-worthy changed.',
        created_at: 1_783_000_000,
      });
    });

    // First, get a real published bundle on disk (so maintain() takes the
    // "changed inputs" path rather than the disabled-capability or no-report
    // early exits) — then poison it with a bare agent-authored concept file
    // that passes adoption (a `type` field present) but fails myco_strict
    // (missing recommended fields), exactly as bundle-failure-injection.test.ts's
    // "validation failure" case does. The next finalize call re-gathers,
    // re-stages, and myco_strict rejects the staged tree.
    await finalizeOnTaskSuccess({
      taskName: OKF_MAINTAIN_TASK,
      agentId: AGENT_ID,
      runId: 'run-finalize-4',
      runContext: undefined,
      requestContext: ctx,
      vaultDir,
    });
    expect(fs.existsSync(path.join(projectRoot, 'okf/index.md'))).toBe(true);

    const conceptsDir = path.join(projectRoot, 'okf/concepts');
    fs.mkdirSync(conceptsDir, { recursive: true });
    fs.writeFileSync(path.join(conceptsDir, 'bare.md'), '---\ntype: Note\n---\n\nBare.\n');

    seedGroveDb(() => {
      insertSpore({ id: 'decision-2', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A second decision forces a real run.', importance: 5, created_at: 1_783_000_100, machine_id: 'machine-a' });
      insertRun({ id: 'run-finalize-5', project_id: PROJECT_ID, agent_id: AGENT_ID, task: OKF_MAINTAIN_TASK, status: 'running', started_at: 1_783_000_100 });
      insertReport({
        run_id: 'run-finalize-5',
        project_id: PROJECT_ID,
        agent_id: AGENT_ID,
        action: OKF_REPORT_ACTION,
        summary: 'Second run.',
        created_at: 1_783_000_100,
      });
    });

    await expect(
      finalizeOnTaskSuccess({
        taskName: OKF_MAINTAIN_TASK,
        agentId: AGENT_ID,
        runId: 'run-finalize-5',
        runContext: undefined,
        requestContext: ctx,
        vaultDir,
      }),
    ).rejects.toMatchObject({ code: 'okf_validation_failed' });
  });
});
