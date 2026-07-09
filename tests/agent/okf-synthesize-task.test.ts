/**
 * End-to-end coverage for the okf-synthesize task's explore → plan →
 * map-synthesize → finalize pipeline over the DB-resident wiki, and its
 * load-bearing invariants:
 *
 *   1. THE PLAN→MAP HANDOFF. The `plan` phase persists a WikiPlan on the
 *      DRAFT okf_generations row via okf_write_plan; the `synthesize` map
 *      phase's SOURCE tool (okf_list_planned_pages) reads it back — a map
 *      source is called with only {params}, so the persisted draft is the
 *      ONLY channel between the phases. This test drives the REAL synthesize
 *      phase loaded from the task YAML.
 *
 *   2. ROWS ARE DURABLE. Every okf_write_page lands a head upsert + revision
 *      row immediately; a run that dies mid-map loses nothing, and the next
 *      okf_write_plan supersedes the abandoned draft. The executor's
 *      finalizeOkfSynthesize flips the draft to published (or blocked).
 *
 * Uses the grove-DB fixture pattern from tests/agent/okf-tools.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openDatabase, withDatabase, closeDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { insertRun } from '@myco/db/queries/runs.js';
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
import { okfSynthesizeDue, computeOkfSynthesizeSnapshot } from '@myco/okf/schedule.js';
import { OkfStore } from '@myco/okf/store.js';
import { latestOkfGeneration, listRevisionsForGeneration } from '@myco/db/queries/okf.js';
import { createOkfTools } from '@myco/agent/tools/okf-tools.js';
import { createExplorationTools } from '@myco/agent/tools/exploration-tools.js';
import { createReadTools } from '@myco/agent/tools/read-tools.js';
import { loadAgentTasks } from '@myco/agent/loader.js';
import { executeMapPhase } from '@myco/agent/map-phase.js';
import { computeWaves, finalizeOkfSynthesize } from '@myco/agent/executor.js';
import { OKF_SYNTHESIZE_TASK } from '@myco/agent/instruction-builders.js';
import type { PhaseDefinition } from '@myco/agent/types.js';
import type { VaultToolDeps } from '@myco/agent/tools/types.js';
import { vi } from '../helpers/vi-shim.js';

const PROJECT_ID = 'proj_ffffffffffffffffffffffffffffffff';
const AGENT_ID = 'claude-code';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = path.resolve(__dirname, '..', '..', 'packages', 'myco', 'src', 'agent', 'definitions');

/** The three pages the plan phase writes, and the map phase then synthesizes. */
const PLANNED_PAGES = [
  { path: 'concepts/alpha', type: 'concept', title: 'Alpha', rationale: 'Core concept.', sourceRefs: ['decision-1'] },
  { path: 'concepts/beta', type: 'concept', title: 'Beta', rationale: 'Second concept.', sourceRefs: ['decision-1'] },
  { path: 'guides/overview', type: 'overview', title: 'Overview', rationale: 'Reader entry point.', sourceRefs: [] },
];

async function invoke(t: { handler: (args: unknown) => Promise<unknown> }, args: Record<string, unknown>): Promise<any> {
  const result = (await t.handler(args)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0].text);
}

/**
 * The synthesize map phase resolves its sink + `item.readTools` from the FULL
 * tool registry (in production, createVaultTools). Build the same subset here
 * — okf tools + fs/grep exploration + the vault search read tools — for any
 * test that drives executeMapPhase.
 */
function okfSurfaceTools(d: VaultToolDeps) {
  return [...createOkfTools(d), ...createExplorationTools(d), ...createReadTools(d)];
}

describe('okf-synthesize task — explore → plan → map-synthesize → finalize (DB-resident)', () => {
  let rootDir: string;
  let vaultDir: string;
  let projectRoot: string;
  let groveDbPath: string;
  let groveId: string;
  let ctx: MycoRequestContext;
  let deps: VaultToolDeps;
  let synthesizePhase: PhaseDefinition;

  function seedGroveDb(seed: () => void): void {
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    createSchema(db);
    withDatabase(db, seed);
    db.close();
    initDatabase(groveDbPath);
  }

  function store(): OkfStore {
    return new OkfStore({
      scope: projectScopeFromRequestContext(ctx),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config: loadMergedConfig(vaultDir, { groveId }),
    });
  }

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-synth-')));
    const home = path.join(rootDir, 'home');
    projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');

    const grove = createGrove('Work', home);
    groveId = grove.id;
    saveProjectManifest(vaultDir, {
      project: { id: PROJECT_ID, name: 'okf-synth' },
      grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-synth', projectRoot, bindingId: 'g' }, home);
    groveDbPath = resolveGroveDbPath(grove.id, home);

    ctx = resolveLegacyRequestContext(vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: grove.id,
      machineId: 'machine-a',
      tenancySource: 'caller',
    });

    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
      insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A decision.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
      insertRun({ id: 'run-okf-synth-1', project_id: PROJECT_ID, agent_id: AGENT_ID, task: OKF_SYNTHESIZE_TASK, status: 'running', started_at: 1_783_000_000 });
    });

    deps = {
      agentId: AGENT_ID,
      runId: 'run-okf-synth-1',
      projectRoot,
      vaultDir,
      requestContext: ctx,
      machineId: 'machine-a',
      recordTurn: () => null,
    };

    const okfTask = loadAgentTasks(DEFINITIONS_DIR).find((t) => t.name === OKF_SYNTHESIZE_TASK)!;
    synthesizePhase = okfTask.phases!.find((p) => p.name === 'synthesize')! as unknown as PhaseDefinition;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeDatabase();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  /** Stub harness runtime: the map item "model" writes body+description through the pinned sink. */
  function stubRuntime(bodyFor: (itemPath: string) => string) {
    return {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async (input: any) => {
        const sink = input.toolSurface.tools.find((t: any) => t.name === 'okf_write_page');
        const itemPath = input.prompt.match(/Path: (\S+)/)![1];
        await sink.handler({
          description: `Summary of ${itemPath}.`,
          body: bodyFor(itemPath),
        });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 }, sessionRef: undefined };
      }),
    };
  }

  async function runMapPhase(tools: ReturnType<typeof okfSurfaceTools>, runtime: ReturnType<typeof stubRuntime>) {
    return executeMapPhase({
      phase: synthesizePhase,
      allTools: tools as any,
      harness: runtime as any,
      params: {},
      systemPrompt: 'sys',
      runId: deps.runId!,
      agentId: deps.agentId,
      taskName: OKF_SYNTHESIZE_TASK,
      model: 'stub',
      logger: undefined,
    } as any);
  }

  it('orders phases explore → plan → synthesize (guards the plan→map handoff)', () => {
    const okfTask = loadAgentTasks(DEFINITIONS_DIR).find((t) => t.name === OKF_SYNTHESIZE_TASK)!;
    const waves = computeWaves(okfTask.phases!);
    const waveOf = (name: string) => waves.findIndex((w) => w.some((p) => p.name === name));
    expect(waveOf('plan')).toBeGreaterThan(waveOf('explore'));
    expect(waveOf('synthesize')).toBeGreaterThan(waveOf('plan'));
  });

  it('persists the plan as the draft generation, fans out one page per entry, and finalize publishes the rows', async () => {
    const tools = okfSurfaceTools(deps);
    const readSources = tools.find((t) => t.name === 'okf_read_sources')!;
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;

    const sources = await invoke(readSources, {});
    expect(sources.error).toBeUndefined();
    expect(Array.isArray(sources.repoTree.topLevelDirs)).toBe(true);
    expect(typeof sources.guidance).toBe('string');

    const planResult = await invoke(writePlan, { pages: PLANNED_PAGES });
    expect(planResult.ok).toBe(true);
    expect(planResult.pageCount).toBe(3);
    expect(planResult.generation).toBe(1);
    const draft = store().currentDraft();
    expect(draft).not.toBeNull();
    expect((JSON.parse(draft!.plan).pages as Array<{ path: string }>).map((p) => p.path))
      .toEqual(['concepts/alpha', 'concepts/beta', 'guides/overview']);

    const runtime = stubRuntime((p) => `Synthesized content for ${p}. See [Alpha](/concepts/alpha.md).`);
    const mapResult = await runMapPhase(tools, runtime);
    expect(mapResult.failed).toBe(0);
    expect(mapResult.written).toBe(3);
    expect(listRevisionsForGeneration(draft!.id)).toHaveLength(3);

    await finalizeOkfSynthesize({ agentId: AGENT_ID, runId: deps.runId!, requestContext: ctx, vaultDir });
    const published = store().latestPublished();
    expect(published?.id).toBe(draft!.id);
    expect(published?.page_count).toBe(3);
    expect(published?.last_run_ref).toBeTruthy();

    const beta = store().readPage('concepts/beta');
    expect(beta?.body).toContain('[Alpha](/concepts/alpha.md)');
    // No filesystem output: the wiki is rows; disk is claim-scope.
    expect(fs.existsSync(path.join(projectRoot, 'okf'))).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, 'okf'))).toBe(false);
  });

  it('a run that dies mid-map loses nothing: rows persist, the source excludes written pages, a new plan supersedes', async () => {
    const tools = okfSurfaceTools(deps);
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;
    const listPlanned = tools.find((t) => t.name === 'okf_list_planned_pages')!;
    const writePage = tools.find((t) => t.name === 'okf_write_page')!;

    await invoke(writePlan, { pages: PLANNED_PAGES });
    await invoke(writePage, { path: 'concepts/alpha', type: 'concept', title: 'Alpha', description: 'd', body: 'Alpha body.' });
    await invoke(writePage, { path: 'concepts/beta', type: 'concept', title: 'Beta', description: 'd', body: 'Beta body.' });

    const remaining = await invoke(listPlanned, {});
    expect(remaining.pages.map((p: { path: string }) => p.path)).toEqual(['guides/overview']);
    expect(remaining.alreadyWritten).toEqual(['concepts/alpha', 'concepts/beta']);

    expect(store().readPage('concepts/alpha')?.body).toBe('Alpha body.');

    const second = await invoke(writePlan, { pages: PLANNED_PAGES });
    expect(second.generation).toBe(2);
    const freshList = await invoke(listPlanned, {});
    expect(freshList.pages).toHaveLength(3);
    expect(store().latest()?.generation).toBe(2);
  });

  it('re-synthesizing an existing page bumps its generation and serves the refined content', async () => {
    const tools = okfSurfaceTools(deps);
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;

    await invoke(writePlan, { pages: PLANNED_PAGES });
    await runMapPhase(tools, stubRuntime((p) => `First pass for ${p}.`));
    await finalizeOkfSynthesize({ agentId: AGENT_ID, runId: deps.runId!, requestContext: ctx, vaultDir });

    await invoke(writePlan, { pages: [PLANNED_PAGES[0]] });
    await runMapPhase(tools, stubRuntime((p) => `Refined pass for ${p}.`));
    await finalizeOkfSynthesize({ agentId: AGENT_ID, runId: deps.runId!, requestContext: ctx, vaultDir });

    expect(store().readPage('concepts/alpha')?.body).toBe('Refined pass for concepts/alpha.');
    expect(store().readPage('concepts/beta')?.body).toBe('First pass for concepts/beta.');
    const published = store().latestPublished()!;
    expect(published.generation).toBe(2);
    expect(published.page_count).toBe(1);
  });

  it('a generation carrying a secret blocks at finalize; acknowledge publishes it without re-synthesis', async () => {
    const tools = okfSurfaceTools(deps);
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;

    await invoke(writePlan, { pages: [PLANNED_PAGES[0]] });
    await runMapPhase(tools, stubRuntime(() => 'Token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 leaked.'));
    await finalizeOkfSynthesize({ agentId: AGENT_ID, runId: deps.runId!, requestContext: ctx, vaultDir });

    const latest = store().latest()!;
    expect(latest.status).toBe('blocked');
    expect(JSON.parse(latest.findings).some((f: { code: string }) => f.code === 'likely_secret')).toBe(true);
    expect(store().latestPublished()).toBeNull();

    store().acknowledge();
    expect(store().latestPublished()?.id).toBe(latest.id);
  });
});

describe('okfSynthesizeDue precondition — generation-row baseline', () => {
  let rootDir: string;
  let vaultDir: string;
  let projectRoot: string;
  let groveDbPath: string;
  let groveId: string;
  let ctx: MycoRequestContext;

  function seedGroveDb(seed: () => void): void {
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    createSchema(db);
    withDatabase(db, seed);
    db.close();
    initDatabase(groveDbPath);
  }

  function store(): OkfStore {
    return new OkfStore({
      scope: projectScopeFromRequestContext(ctx),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config: loadMergedConfig(vaultDir, { groveId }),
    });
  }

  function due(): boolean {
    return okfSynthesizeDue(
      projectScopeFromRequestContext(ctx),
      loadMergedConfig(vaultDir, { groveId }),
      projectRoot,
      PROJECT_ID,
      'machine-a',
      latestOkfGeneration(projectScopeFromRequestContext(ctx), ['published']),
    );
  }

  /** Publish one generation whose inputs_hash/last_run_ref match the LIVE snapshot (a just-ran state). */
  function publishBaseline(sourceRefs: string[] = []): void {
    const s = store();
    const draft = s.createDraftGeneration({
      runId: 'r-base',
      plan: {
        generatedAt: '2026-07-08T12:00:00Z',
        sinceRef: '',
        pages: [{ path: 'concepts/alpha', type: 'concept', title: 'Alpha', rationale: 'x', sourceRefs }],
      },
    });
    s.writePage({ path: 'concepts/alpha', type: 'concept', title: 'Alpha', description: 'd', body: 'Body.' });
    const snapshot = computeOkfSynthesizeSnapshot(
      projectScopeFromRequestContext(ctx),
      loadMergedConfig(vaultDir, { groveId })!,
      projectRoot,
      PROJECT_ID,
      'machine-a',
    );
    s.finalizeGeneration(draft.id, { inputsHash: snapshot.probeFingerprint, lastRunRef: snapshot.lastRunRef });
  }

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-due-')));
    const home = path.join(rootDir, 'home');
    projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');

    const grove = createGrove('Work', home);
    groveId = grove.id;
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
    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeDatabase();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('due=true when no generation has ever been published', () => {
    expect(due()).toBe(true);
  });

  it('due=false immediately after a publish whose baseline matches the live snapshot', () => {
    publishBaseline();
    expect(due()).toBe(false);
  });

  it('due=true again when vault knowledge changes after the publish', () => {
    publishBaseline();
    withDatabase(openDatabase(groveDbPath), () => {
      insertSpore({ id: 'new-spore', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'gotcha', content: 'New knowledge.', importance: 5, created_at: 1_783_100_000, machine_id: 'machine-a' });
    });
    initDatabase(groveDbPath);
    expect(due()).toBe(true);
  });

  it('due=true when a commit touches a planned page sourceRef path; false for untracked paths', () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' });
    fs.writeFileSync(path.join(projectRoot, 'tracked.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(projectRoot, 'other.md'), 'notes\n');
    git(['init', '-q']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 'T']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'initial']);

    publishBaseline(['tracked.ts']);
    expect(due()).toBe(false);

    fs.writeFileSync(path.join(projectRoot, 'other.md'), 'notes changed\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'docs-only']);
    expect(due()).toBe(false);

    fs.writeFileSync(path.join(projectRoot, 'tracked.ts'), 'export const x = 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'tracked change']);
    expect(due()).toBe(true);
  });

  it('a non-git project never throws and rests on the vault signal alone', () => {
    publishBaseline(['tracked.ts']);
    expect(due()).toBe(false);
  });
});
