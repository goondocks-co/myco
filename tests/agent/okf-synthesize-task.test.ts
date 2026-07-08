/**
 * End-to-end coverage for the okf-synthesize task's explore → plan →
 * map-synthesize → publish pipeline and its two load-bearing invariants:
 *
 *   1. THE PLAN→MAP HANDOFF. The `plan` phase persists a WikiPlan via
 *      okf_write_plan (.myco/okf/state/plan.json); the `synthesize` map
 *      phase's SOURCE tool (okf_list_planned_pages) reads it back — a map
 *      source is called with only {params}, so a persisted plan is the ONLY
 *      channel between the phases. This test drives the REAL synthesize phase
 *      loaded from the task YAML.
 *
 *   2. ONE LOCK ACQUISITION PER RUN. Every okf_write_page appends to a single
 *      staged generation opened lazily on the first write; the executor's
 *      finalizeOkfSynthesize publishes it once. We spy on
 *      OkfBundle.beginStagedGeneration to assert exactly one acquisition
 *      across three page writes, and that the published bundle passes strict
 *      validation with the three planned pages + generated indexes.
 *
 * Uses the grove-DB fixture pattern from tests/agent/okf-tools.test.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
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
import { assertGroveProjectId, createProjectId, projectScope, type ProjectScope } from '@myco/grove/ids.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle } from '@myco/okf/bundle.js';
import { readOwnership, isHandEdited } from '@myco/okf/ownership.js';
import { readPlan } from '@myco/okf/synthesis/plan.js';
import { okfSynthesizeDue, computeOkfProbeFingerprint } from '@myco/okf/schedule.js';
import { createOkfTools } from '@myco/agent/tools/okf-tools.js';
import { createExplorationTools } from '@myco/agent/tools/exploration-tools.js';
import { createReadTools } from '@myco/agent/tools/read-tools.js';
import { loadAgentTasks } from '@myco/agent/loader.js';
import { executeMapPhase } from '@myco/agent/map-phase.js';
import { computeWaves } from '@myco/agent/executor.js';
import { finalizeOkfSynthesize, cleanupOnTaskFailure } from '@myco/agent/executor.js';
import { hasOkfSynthesisSession } from '@myco/agent/tools/okf-staging.js';
import { OKF_SYNTHESIZE_TASK } from '@myco/agent/instruction-builders.js';
import type { PhaseDefinition } from '@myco/agent/types.js';
import type { VaultToolDeps } from '@myco/agent/tools/types.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
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
 * tool registry (in production, createVaultTools). The explore/synthesize
 * surfaces now carry the code/vault exploration read tools alongside the okf
 * tools, so build that same subset here — okf tools + fs/grep exploration +
 * the vault search read tools — for any test that drives executeMapPhase.
 */
function okfSurfaceTools(d: VaultToolDeps) {
  return [...createOkfTools(d), ...createExplorationTools(d), ...createReadTools(d)];
}

describe('okf-synthesize task — explore → plan → map-synthesize → publish', () => {
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

  function publishedBundle(): OkfBundle {
    return new OkfBundle({
      projectRoot,
      vault: new ProjectVault(projectRoot),
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

  it('orders phases explore → plan → synthesize (guards the plan→map handoff)', () => {
    const okfTask = loadAgentTasks(DEFINITIONS_DIR).find((t) => t.name === OKF_SYNTHESIZE_TASK)!;
    const waves = computeWaves(okfTask.phases!);
    const waveOf = (name: string) => waves.findIndex((w) => w.some((p) => p.name === name));
    // synthesize's map source (okf_list_planned_pages) reads plan.json, which the
    // `plan` phase writes — so synthesize MUST run in a strictly later wave than
    // plan, or the map phase reads a missing/stale plan (silent handoff failure).
    expect(waveOf('plan')).toBeGreaterThan(waveOf('explore'));
    expect(waveOf('synthesize')).toBeGreaterThan(waveOf('plan'));
  });

  it('persists the plan, fans out one page per plan entry under ONE lock, and publishes a strict bundle once', async () => {
    const beginSpy = spyOn(OkfBundle.prototype, 'beginStagedGeneration');
    try {
      const tools = okfSurfaceTools(deps);
      const readSources = tools.find((t) => t.name === 'okf_read_sources')!;
      const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;

      // --- explore: read-only source survey (no writes) ---
      const sources = await invoke(readSources, {});
      expect(sources.error).toBeUndefined();
      // repoTree is a bounded orientation object (not a full file dump), and the
      // orientation call carries explore-from-here guidance.
      expect(Array.isArray(sources.repoTree.topLevelDirs)).toBe(true);
      expect(typeof sources.repoTree.totalFiles).toBe('number');
      expect(typeof sources.guidance).toBe('string');

      // --- plan: persist the capped WikiPlan (the ONLY channel to the map phase) ---
      const planResult = await invoke(writePlan, { pages: PLANNED_PAGES });
      expect(planResult.ok).toBe(true);
      expect(planResult.pageCount).toBe(3);
      const persisted = readPlan(new ProjectVault(projectRoot));
      expect(persisted?.pages.map((p) => p.path)).toEqual(['concepts/alpha', 'concepts/beta', 'guides/overview']);

      // --- synthesize (map): source reads plan.json back; sink stages each page ---
      const stubRuntime = {
        id: 'claude-sdk' as const,
        supports: () => false,
        execute: mock(async (input: any) => {
          const sink = input.toolSurface.tools.find((t: any) => t.name === 'okf_write_page');
          const itemPath = input.prompt.match(/Path: (\S+)/)![1];
          // path/type/title are pinned by argMap; the model supplies body+description.
          await sink.handler({
            description: `Summary of ${itemPath}.`,
            body: `Synthesized content for ${itemPath}. This page draws on project decisions.`,
          });
          return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 }, sessionRef: undefined };
        }),
      };

      const mapResult = await executeMapPhase({
        phase: synthesizePhase,
        allTools: tools as any,
        harness: stubRuntime as any,
        params: {},
        systemPrompt: 'sys',
        runId: deps.runId,
        agentId: deps.agentId,
        projectRoot,
        vaultDir,
        probeAvailable: async () => true,
      });

      expect(mapResult.itemCount).toBe(3);
      expect(mapResult.written).toBe(3);
      expect(mapResult.skipped).toBe(0);
      expect(mapResult.failed).toBe(0);
      expect(stubRuntime.execute).toHaveBeenCalledTimes(3);

      // The three page writes opened the staged generation exactly ONCE.
      expect(beginSpy).toHaveBeenCalledTimes(1);
      expect(hasOkfSynthesisSession(deps.runId)).toBe(true);

      // --- executor finalize: publish the single staged tree once ---
      await finalizeOkfSynthesize({ agentId: deps.agentId, runId: deps.runId, requestContext: ctx, vaultDir });

      // Still one acquisition — finalize publishes the OPEN session, it does not
      // re-open one. The session is dropped after publish.
      expect(beginSpy).toHaveBeenCalledTimes(1);
      expect(hasOkfSynthesisSession(deps.runId)).toBe(false);

      // --- Task 2.4: finalize recorded the okf-synthesize-due baseline ---
      const publishedManifest = new ProjectVault(projectRoot).readOkfManifest();
      expect(publishedManifest?.probe_fingerprint).toBeTruthy();
      expect(publishedManifest?.last_run_ref).not.toBeNull();
      // projectRoot here is a plain temp dir, not a git repo — headSha degrades to null, never throws.
      expect(publishedManifest?.last_run_ref?.headSha).toBeNull();
      expect(publishedManifest?.last_run_ref?.maxVaultUpdatedAt).toBeGreaterThan(0);

      // --- published bundle: 3 pages + generated indexes, passes strict ---
      const bundle = publishedBundle();
      const status = bundle.status();
      expect(status.bundleExists).toBe(true);
      expect(status.bundleGeneration).toBe(1);

      const pages = bundle.listPages().map((p) => p.path).sort();
      expect(pages).toEqual(['concepts/alpha.md', 'concepts/beta.md', 'guides/overview.md']);

      expect(bundle.validate().ok).toBe(true);

      const outputRoot = path.join(projectRoot, 'okf');
      expect(fs.existsSync(path.join(outputRoot, 'index.md'))).toBe(true);
      expect(fs.existsSync(path.join(outputRoot, 'concepts', 'index.md'))).toBe(true);

      // plan.json survives the run for audit.
      expect(readPlan(new ProjectVault(projectRoot))?.pages).toHaveLength(3);
    } finally {
      beginSpy.mockRestore();
    }
  });

  it('a failed run aborts the staged generation — publishes nothing and drops the session (no lock leak)', async () => {
    const runId = 'run-okf-synth-abort';
    const abortDeps: VaultToolDeps = { ...deps, runId };
    const tools = createOkfTools(abortDeps);
    const writePage = tools.find((t) => t.name === 'okf_write_page')!;

    // A single page write opens the staged generation (and takes the lock).
    const staged = await invoke(writePage, {
      path: 'concepts/alpha', type: 'concept', title: 'Alpha', description: 'd', body: 'Body.',
    });
    expect(staged.ok).toBe(true);
    expect(hasOkfSynthesisSession(runId)).toBe(true);

    // The run fails before finalize — the executor's failure cleanup aborts.
    await cleanupOnTaskFailure({ taskName: OKF_SYNTHESIZE_TASK, runId, vaultDir, runContext: undefined });

    expect(hasOkfSynthesisSession(runId)).toBe(false);
    // Nothing was published — the prior (absent) bundle is untouched.
    expect(publishedBundle().status().bundleExists).toBe(false);

    // The lock was released, not leaked: a fresh staged generation for another
    // run acquires immediately (a leaked lock would hang until the 30s timeout).
    const bundle = publishedBundle();
    const next = await bundle.beginStagedGeneration({ mode: 'published', generatedByRunId: 'run-after-abort' });
    next.abort();
  });

  // The hand-edited page's body is fully REPLACED (not appended-to) by the
  // human, so a "good" refine that carries `HAND_EDIT_ADDENDUM` forward
  // verbatim is a clean containment check against the whole current body —
  // no ambiguity about how much of the original Myco text needs to survive.
  const HAND_EDIT_ADDENDUM = 'Human addendum: alpha is also useful for onboarding new teammates.';

  function handEditedAlphaRaw(): string {
    return [
      '---',
      'type: concept',
      'title: Alpha',
      'description: Hand-edited by a person.',
      "timestamp: '2026-07-01T00:00:00.000Z'",
      '---',
      '',
      HAND_EDIT_ADDENDUM,
      '',
    ].join('\n');
  }

  it('refine-not-clobber: a foreign page is rejected untouched AND carried forward, a hand-edited Myco page is augmented, and siblings link via okf_list_pages', async () => {
    // --- Seed a published bundle with one Myco page. ---
    const seedBundle = publishedBundle();
    const seed = await seedBundle.beginStagedGeneration({ mode: 'published' });
    seed.stageDocument({
      path: 'concepts/alpha.md',
      frontmatter: { type: 'concept', title: 'Alpha', description: 'Original alpha.', timestamp: '2026-07-01T00:00:00.000Z' },
      body: 'Original Myco-synthesized body for alpha.',
    });
    await seed.finalize({ inputsHash: 'seed-1' });

    const outputRoot = path.join(projectRoot, 'okf');
    // A human replaces alpha's content entirely — the fingerprint no longer
    // matches ownership, so it reads as hand-edited.
    fs.writeFileSync(path.join(outputRoot, 'concepts', 'alpha.md'), handEditedAlphaRaw());
    // A human drops a brand-new page directly into the bundle — Myco never
    // published it, so it's absent from ownership entirely.
    fs.mkdirSync(path.join(outputRoot, 'concepts'), { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'concepts', 'human-notes.md'),
      "---\ntype: note\ntitle: Human Notes\ndescription: Written by a person.\ntimestamp: '2026-07-02T00:00:00.000Z'\n---\n\nThese are notes a human wrote directly; Myco never published this page.\n",
    );

    // --- This run's plan targets all three: the hand-edited page (refresh),
    // the foreign page (deliberately, to exercise the reject guard), and a
    // brand-new sibling page. A dedicated runId keeps this test's staged
    // session isolated from its siblings (mirrors the "aborts" test above) —
    // load-bearing if an assertion throws before finalize drops the session.
    const runId = 'run-okf-synth-refine';
    const refineDeps: VaultToolDeps = { ...deps, runId };
    const tools = okfSurfaceTools(refineDeps);
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;
    const planResult = await invoke(writePlan, {
      pages: [
        { path: 'concepts/alpha', type: 'concept', title: 'Alpha', rationale: 'Refresh with new material.', sourceRefs: ['decision-1'] },
        { path: 'concepts/human-notes', type: 'note', title: 'Human Notes', rationale: 'Plan targets a foreign page.', sourceRefs: [] },
        { path: 'concepts/beta', type: 'concept', title: 'Beta', rationale: 'New sibling page.', sourceRefs: ['decision-1'] },
      ],
    });
    expect(planResult.ok).toBe(true);

    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async (input: any) => {
        const sink = input.toolSurface.tools.find((t: any) => t.name === 'okf_write_page');
        const itemPath = input.prompt.match(/Path: (\S+)/)![1];

        if (itemPath === 'concepts/alpha') {
          // Read current content first (the item prompt's instruction), then
          // refine it forward — the human's addendum survives verbatim.
          const readPage = input.toolSurface.tools.find((t: any) => t.name === 'okf_read_page');
          const current = await invoke(readPage, { path: itemPath });
          expect(current.page.raw).toContain(HAND_EDIT_ADDENDUM);
          await sink.handler({
            description: 'Refreshed alpha.',
            body: `Refreshed synthesis for alpha with fresh material.\n\n${HAND_EDIT_ADDENDUM}`,
          });
        } else if (itemPath === 'concepts/human-notes') {
          // A refine that ignores the foreign page entirely — the tool must
          // reject this outright regardless of what content is proposed.
          await sink.handler({ description: 'Overwritten notes.', body: 'Synthesis replacing the human page.' });
        } else {
          // Beta: weave in a sibling link discovered via okf_list_pages.
          const listPages = input.toolSurface.tools.find((t: any) => t.name === 'okf_list_pages');
          const listed = await invoke(listPages, {});
          expect(listed.pages.some((p: any) => p.path === 'concepts/alpha.md')).toBe(true);
          await sink.handler({
            description: 'New sibling page.',
            body: 'Beta covers the second concept. See also [Alpha](alpha.md) for related background.',
          });
        }

        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 }, sessionRef: undefined };
      }),
    };

    const mapResult = await executeMapPhase({
      phase: synthesizePhase,
      allTools: tools as any,
      harness: stubRuntime as any,
      params: {},
      systemPrompt: 'sys',
      runId,
      agentId: refineDeps.agentId,
      projectRoot,
      vaultDir,
      probeAvailable: async () => true,
    });

    // alpha (augmented) + beta (new) staged; human-notes rejected untouched.
    expect(mapResult.itemCount).toBe(3);
    expect(mapResult.written).toBe(2);
    expect(mapResult.skipped).toBe(1);
    expect(mapResult.skipReasons.not_myco_owned).toBe(1);

    await finalizeOkfSynthesize({ agentId: refineDeps.agentId, runId, requestContext: ctx, vaultDir });

    const bundle = publishedBundle();
    const alpha = bundle.readPage('concepts/alpha.md');
    // Augmented: both the fresh synthesis AND the human's current content
    // survive — no clobber. The refine already carried the addendum forward,
    // so the tool's append fallback never had to engage (no marker present).
    expect(alpha?.raw).toContain('Refreshed synthesis for alpha with fresh material.');
    expect(alpha?.raw).toContain(HAND_EDIT_ADDENDUM);
    expect(alpha?.raw).not.toContain('okf:preserved-hand-edit');

    const beta = bundle.readPage('concepts/beta.md');
    // Task 7.5: the model's relative sibling link is normalized to the canonical
    // absolute bundle-relative form at finalize (it resolves to a real page).
    expect(beta?.raw).toContain('[Alpha](/concepts/alpha.md)');
    expect(beta?.raw).not.toContain('[Alpha](alpha.md)');

    // The foreign page was never staged (the tool rejected the write before
    // touching anything), but staging carries forward every currently-
    // published page this run doesn't touch (Task 3.3) — the human's page
    // survives finalize's atomic-replace with its content untouched, exactly
    // as if it had never been targeted by the plan at all.
    expect(bundle.listPages().map((p) => p.path)).toContain('concepts/human-notes.md');
    const humanNotes = bundle.readPage('concepts/human-notes.md');
    expect(humanNotes?.raw).toContain('These are notes a human wrote directly; Myco never published this page.');
  });

  it('okf_write_page falls back to appending the current content when a refine drops it entirely (structural backstop)', async () => {
    const seedBundle = publishedBundle();
    const seed = await seedBundle.beginStagedGeneration({ mode: 'published' });
    seed.stageDocument({
      path: 'concepts/alpha.md',
      frontmatter: { type: 'concept', title: 'Alpha', description: 'Original alpha.', timestamp: '2026-07-01T00:00:00.000Z' },
      body: 'Original Myco-synthesized body for alpha.',
    });
    await seed.finalize({ inputsHash: 'seed-1' });

    const outputRoot = path.join(projectRoot, 'okf');
    fs.writeFileSync(path.join(outputRoot, 'concepts', 'alpha.md'), handEditedAlphaRaw());

    // Call okf_write_page directly (no map phase) with a body that does NOT
    // mention the human's addendum at all — a blind-clobber attempt. A
    // dedicated runId keeps this test's staged session isolated from its
    // siblings (mirrors the "aborts" test above).
    const runId = 'run-okf-synth-augment-fallback';
    const fallbackDeps: VaultToolDeps = { ...deps, runId };
    const tools = createOkfTools(fallbackDeps);
    const writePage = tools.find((t) => t.name === 'okf_write_page')!;
    const result = await invoke(writePage, {
      path: 'concepts/alpha', type: 'concept', title: 'Alpha',
      description: 'Blind refresh.', body: 'Completely new content that ignores the current page.',
    });
    expect(result.ok).toBe(true);

    await finalizeOkfSynthesize({ agentId: fallbackDeps.agentId, runId, requestContext: ctx, vaultDir });

    const alpha = publishedBundle().readPage('concepts/alpha.md');
    // The tool's structural fallback engaged: the new content is staged, but
    // the human's current content is appended verbatim under the marker — the
    // invariant holds even though the caller didn't read-then-refine properly.
    expect(alpha?.raw).toContain('Completely new content that ignores the current page.');
    expect(alpha?.raw).toContain('okf:preserved-hand-edit');
    expect(alpha?.raw).toContain(HAND_EDIT_ADDENDUM);
  });

  it('a page exists but ownership.json is entirely absent (cold-start) — the write is adopted and reconciled, not rejected as foreign', async () => {
    // Seed a published bundle the normal way (this DOES write ownership.json
    // via Task 3.1's finalize hook) ...
    const seedBundle = publishedBundle();
    const seed = await seedBundle.beginStagedGeneration({ mode: 'published' });
    seed.stageDocument({
      path: 'concepts/alpha.md',
      frontmatter: { type: 'concept', title: 'Alpha', description: 'Original alpha.', timestamp: '2026-07-01T00:00:00.000Z' },
      body: 'Original Myco-synthesized body for alpha.',
    });
    await seed.finalize({ inputsHash: 'seed-1' });

    // ... then delete it, simulating a bundle published before ownership
    // tracking existed at all (this repo's own pre-3.1 bundle, live right now).
    const ownershipPath = new ProjectVault(projectRoot).okfOwnershipPath();
    expect(fs.existsSync(ownershipPath)).toBe(true);
    fs.rmSync(ownershipPath);

    const runId = 'run-okf-synth-cold-start';
    const coldStartDeps: VaultToolDeps = { ...deps, runId };
    const tools = createOkfTools(coldStartDeps);
    const writePage = tools.find((t) => t.name === 'okf_write_page')!;

    const result = await invoke(writePage, {
      path: 'concepts/alpha', type: 'concept', title: 'Alpha',
      description: 'Refreshed alpha.', body: 'Refreshed content for alpha, a normal update.',
    });
    // Adopted, not rejected as foreign — a bundle-generation-1 page with no
    // ownership record is Myco's own past output, not a human's page.
    expect(result.ok).toBe(true);

    await finalizeOkfSynthesize({ agentId: coldStartDeps.agentId, runId, requestContext: ctx, vaultDir });

    // Ownership was backfilled to the republished generation.
    const ownership = readOwnership(new ProjectVault(projectRoot));
    expect(ownership?.bundleGeneration).toBe(2);
    expect(ownership?.pages['concepts/alpha.md']).toBeDefined();

    // Adopted as clean (not hand-edited): the refresh replaced the content
    // outright — no preserved-hand-edit marker, because reconciliation used
    // the current on-disk content itself as the baseline fingerprint.
    const alpha = publishedBundle().readPage('concepts/alpha.md');
    expect(alpha?.raw).toContain('Refreshed content for alpha, a normal update.');
    expect(alpha?.raw).not.toContain('okf:preserved-hand-edit');
  });

  it('THREE-RUN WALK (Task 7.1): a hand-edit survives a carry-forward run and is augmented — not clobbered — when alpha is re-planned', async () => {
    // --- Run 1: Myco publishes alpha. ---
    const seed = await publishedBundle().beginStagedGeneration({ mode: 'published' });
    seed.stageDocument({
      path: 'concepts/alpha.md',
      frontmatter: { type: 'concept', title: 'Alpha', description: 'Original alpha.', timestamp: '2026-07-01T00:00:00.000Z' },
      body: 'Original Myco-synthesized body for alpha.',
    });
    await seed.finalize({ inputsHash: 'seed-1' });

    const outputRoot = path.join(projectRoot, 'okf');
    const alphaPath = path.join(outputRoot, 'concepts', 'alpha.md');
    const originalFingerprint = readOwnership(new ProjectVault(projectRoot))?.pages['concepts/alpha.md'].fingerprint;
    expect(originalFingerprint).toBeTruthy();

    // A human hand-edits alpha directly on disk (replaces the body entirely).
    const handEdited = handEditedAlphaRaw();
    fs.writeFileSync(alphaPath, handEdited);

    // --- Run 2: a synthesis whose plan does NOT include alpha — it writes a
    // DIFFERENT page (beta) and carries alpha forward untouched. ---
    const run2 = 'run-okf-7-1-carry';
    const deps2: VaultToolDeps = { ...deps, runId: run2 };
    const writePage2 = createOkfTools(deps2).find((t) => t.name === 'okf_write_page')!;
    expect((await invoke(writePage2, {
      path: 'concepts/beta', type: 'concept', title: 'Beta', description: 'A new sibling.', body: 'Beta body.',
    })).ok).toBe(true);
    await finalizeOkfSynthesize({ agentId: deps2.agentId, runId: run2, requestContext: ctx, vaultDir });

    // The hand-edit survived carry-forward on disk ...
    expect(fs.readFileSync(alphaPath, 'utf8')).toBe(handEdited);
    // ... AND ownership STILL records Myco's ORIGINAL fingerprint. THIS is the
    // fix: before Task 7.1 the carry-forward re-fingerprinted the whole tree,
    // adopting the hand-edit as Myco's own so isHandEdited went false — and the
    // next run would clobber it.
    const ownership2 = readOwnership(new ProjectVault(projectRoot));
    expect(ownership2?.pages['concepts/alpha.md'].fingerprint).toBe(originalFingerprint);
    expect(isHandEdited('concepts/alpha.md', handEdited, ownership2)).toBe(true);

    // --- Run 3: a synthesis that DOES re-plan alpha. A blind refresh that drops
    // the human's addendum — the tool's structural augment backstop must still
    // preserve it, precisely because run 2 kept alpha hand-edited. ---
    const run3 = 'run-okf-7-1-replan';
    const deps3: VaultToolDeps = { ...deps, runId: run3 };
    const writePage3 = createOkfTools(deps3).find((t) => t.name === 'okf_write_page')!;
    expect((await invoke(writePage3, {
      path: 'concepts/alpha', type: 'concept', title: 'Alpha',
      description: 'Refreshed alpha.', body: 'Fresh synthesis for alpha, third run.',
    })).ok).toBe(true);
    await finalizeOkfSynthesize({ agentId: deps3.agentId, runId: run3, requestContext: ctx, vaultDir });

    const alpha = publishedBundle().readPage('concepts/alpha.md');
    // Augment-not-clobber: BOTH the fresh synthesis AND the human's addendum survive.
    expect(alpha?.raw).toContain('Fresh synthesis for alpha, third run.');
    expect(alpha?.raw).toContain(HAND_EDIT_ADDENDUM);
    expect(alpha?.raw).toContain('okf:preserved-hand-edit');
  });

  it('Task 7.5: published body cross-links are all absolute bundle-relative and resolve — 0 dead links', async () => {
    const runId = 'run-okf-synth-links';
    const linkDeps: VaultToolDeps = { ...deps, runId };
    const tools = okfSurfaceTools(linkDeps);
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;
    // A root-level glossary + two nested concept pages — mirrors the 6.3 dogfood
    // shape where root pages linked ../concepts/* (escaping the bundle) and to
    // pages that were never synthesized.
    await invoke(writePlan, {
      pages: [
        { path: 'glossary', type: 'glossary', title: 'Glossary', rationale: 'Root terms.', sourceRefs: [] },
        { path: 'concepts/alpha', type: 'concept', title: 'Alpha', rationale: 'Core.', sourceRefs: [] },
        { path: 'concepts/beta', type: 'concept', title: 'Beta', rationale: 'Second.', sourceRefs: [] },
      ],
    });

    // The exact broken shapes from the dogfood: wrong-depth relative that escapes
    // the bundle, a root-relative link, a dangling link to an unsynthesized page,
    // a bare sibling relative link, and an already-absolute link.
    const bodies: Record<string, string> = {
      glossary: 'Terms. See [Alpha](../concepts/alpha.md), [Beta](concepts/beta.md), and [Ghost](../concepts/ghost.md).',
      'concepts/alpha': 'Alpha. See [Beta](beta.md) and the [Glossary](/glossary.md).',
      'concepts/beta': 'Beta covers the second concept. No cross-links here.',
    };

    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async (input: any) => {
        const sink = input.toolSurface.tools.find((t: any) => t.name === 'okf_write_page');
        const itemPath = input.prompt.match(/Path: (\S+)/)![1];
        await sink.handler({ description: `Summary of ${itemPath}.`, body: bodies[itemPath] });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 }, sessionRef: undefined };
      }),
    };

    const mapResult = await executeMapPhase({
      phase: synthesizePhase,
      allTools: tools as any,
      harness: stubRuntime as any,
      params: {},
      systemPrompt: 'sys',
      runId,
      agentId: linkDeps.agentId,
      projectRoot,
      vaultDir,
      probeAvailable: async () => true,
    });
    expect(mapResult.written).toBe(3);

    await finalizeOkfSynthesize({ agentId: linkDeps.agentId, runId, requestContext: ctx, vaultDir });

    const bundle = publishedBundle();
    const pageSet = new Set(bundle.listPages().map((p) => p.path));
    expect(pageSet).toEqual(new Set(['glossary.md', 'concepts/alpha.md', 'concepts/beta.md']));

    // Resolving links became absolute bundle-relative ...
    const glossary = bundle.readPage('glossary.md')!.raw;
    expect(glossary).toContain('[Alpha](/concepts/alpha.md)');
    expect(glossary).toContain('[Beta](/concepts/beta.md)');
    // ... the dangling link was downgraded to plain text (the reader keeps "Ghost").
    expect(glossary).toContain('and Ghost.');
    expect(glossary).not.toContain('ghost.md');
    const alpha = bundle.readPage('concepts/alpha.md')!.raw;
    expect(alpha).toContain('[Beta](/concepts/beta.md)');
    expect(alpha).toContain('[Glossary](/glossary.md)');

    // Whole-tree invariant: every `.md` body link on a content page is absolute
    // bundle-relative AND resolves to a real published page (0 dead links, and no
    // leftover relative link). Indexes/log are excluded — they are generated with
    // their own relative-link convention, not authored by the model.
    const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
    const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
    for (const pagePath of pageSet) {
      const raw = bundle.readPage(pagePath)!.raw;
      for (const match of raw.matchAll(LINK)) {
        const target = match[1].trim();
        if (target.startsWith('#') || EXTERNAL.test(target)) continue; // anchor / external
        const pathPart = target.split('#')[0];
        if (!pathPart.endsWith('.md')) continue; // asset link, out of scope
        expect(pathPart.startsWith('/')).toBe(true); // absolute bundle-relative
        expect(pageSet.has(pathPart.slice(1))).toBe(true); // resolves to a real page
      }
    }
  });
});

/**
 * `okfSynthesizeDue` (Task 2.4) takes plain values (scope/config/manifest/
 * plan), not a live Grove/registry-backed scope — a lighter in-memory-db
 * fixture (mirroring `tests/okf/synthesis/sources.test.ts`) is enough, no
 * grove registration or MYCO_HOME needed.
 */
describe('okfSynthesizeDue precondition (Task 2.4)', () => {
  const DUE_AGENT = 'claude-code';
  const MACHINE_ID = 'machine-a';
  let dueProjectRoot: string;
  let dueProjectId: string;
  let dueScope: ProjectScope;

  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());

  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: DUE_AGENT, name: 'Myco Agent', created_at: 1_783_000_000 });
    dueProjectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-due-')));
    dueProjectId = createProjectId();
    dueScope = projectScope(dueProjectId as ReturnType<typeof createProjectId>);
  });

  afterEach(() => {
    fs.rmSync(dueProjectRoot, { recursive: true, force: true });
  });

  // Canopy disabled so the vault fingerprint only depends on the spore
  // aggregate — keeps the "meaningful change" expectations legible.
  function dueConfig(): MycoConfig {
    return MycoConfigSchema.parse({
      version: 3,
      okf: { enabled: true },
      cortex: { canopy: { enabled: false } },
    });
  }

  function git(args: string[]): void {
    execFileSync('git', args, { cwd: dueProjectRoot, stdio: 'ignore' });
  }
  function gitOutput(args: string[]): string {
    return execFileSync('git', args, { cwd: dueProjectRoot, encoding: 'utf8' }).trim();
  }
  function initGitRepo(): void {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
  }
  function commitAll(message: string): string {
    git(['add', '-A']);
    git(['commit', '-q', '-m', message]);
    return gitOutput(['rev-parse', 'HEAD']);
  }
  function writeDueFile(rel: string, content: string): void {
    const abs = path.join(dueProjectRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  /** Seed exactly one active spore and return the fingerprint it produces (canopy disabled throughout this suite). */
  function seedBaselineFingerprint(): string {
    insertSpore({
      id: 'gotcha-1',
      project_id: dueProjectId,
      agent_id: DUE_AGENT,
      observation_type: 'gotcha',
      content: 'Baseline gotcha, present before any of these tests run.',
      importance: 5,
      created_at: 1_783_000_000,
      updated_at: 1_783_000_000,
      machine_id: MACHINE_ID,
    });
    return computeOkfProbeFingerprint({
      sporeCount: 1,
      maxSporeUpdate: 1_783_000_000,
      canopyCount: 0,
      maxCanopyUpdate: 0,
      conceptCount: 0,
      mapHash: null,
      include: { spores: true, canopy: false, concepts: false, guides: false },
      sporeStatus: 'active',
    });
  }

  function writePublishedManifest(
    vault: ProjectVault,
    fingerprint: string,
    lastRunRef: { headSha: string | null; maxVaultUpdatedAt: number } | null = null,
  ): void {
    vault.writeOkfManifest({
      bundle_generation: 1,
      inputs_hash: '',
      output_root: path.join(dueProjectRoot, 'okf'),
      last_result: 'published',
      generated_at: new Date().toISOString(),
      acknowledged_findings: [],
      probe_fingerprint: fingerprint,
      last_run_ref: lastRunRef,
    });
  }

  it('due=true when no bundle has been published yet', () => {
    const due = okfSynthesizeDue(dueScope, dueConfig(), dueProjectRoot, dueProjectId, MACHINE_ID, null, null);
    expect(due).toBe(true);
  });

  it('due=false when nothing maps to a page (vault unchanged, no plan tracked)', () => {
    const fingerprint = seedBaselineFingerprint();
    const vault = new ProjectVault(dueProjectRoot);
    writePublishedManifest(vault, fingerprint);

    const due = okfSynthesizeDue(
      dueScope, dueConfig(), dueProjectRoot, dueProjectId, MACHINE_ID,
      vault.readOkfManifest(), null,
    );
    expect(due).toBe(false);
  });

  it("due=false on a docs-only commit that touches no planned page's sourceRefs", () => {
    writeDueFile('src/foo.ts', 'export const x = 1;\n');
    initGitRepo();
    const baseSha = commitAll('initial');

    const fingerprint = seedBaselineFingerprint();
    const vault = new ProjectVault(dueProjectRoot);
    // last_run_ref.headSha = the commit this project was published at.
    writePublishedManifest(vault, fingerprint, { headSha: baseSha, maxVaultUpdatedAt: 1_783_000_000 });
    vault.writeOkfPlan({
      generatedAt: new Date().toISOString(),
      sinceRef: baseSha,
      pages: [{ path: 'concepts/foo', type: 'concept', title: 'Foo', rationale: 'r', sourceRefs: ['src/foo.ts'] }],
    });

    writeDueFile('docs/readme.md', '# hi\n');
    commitAll('docs only');

    const due = okfSynthesizeDue(
      dueScope, dueConfig(), dueProjectRoot, dueProjectId, MACHINE_ID,
      vault.readOkfManifest(), vault.readOkfPlan(),
    );
    expect(due).toBe(false);
  });

  it('due=true on a new spore (vault knowledge changed since the last publish)', () => {
    const fingerprint = seedBaselineFingerprint();
    const vault = new ProjectVault(dueProjectRoot);
    writePublishedManifest(vault, fingerprint);

    insertSpore({
      id: 'gotcha-2',
      project_id: dueProjectId,
      agent_id: DUE_AGENT,
      observation_type: 'gotcha',
      content: 'A new gotcha discovered since the last publish.',
      importance: 5,
      created_at: 1_783_000_500,
      updated_at: 1_783_000_500,
      machine_id: MACHINE_ID,
    });

    const due = okfSynthesizeDue(
      dueScope, dueConfig(), dueProjectRoot, dueProjectId, MACHINE_ID,
      vault.readOkfManifest(), null,
    );
    expect(due).toBe(true);
  });

  it('due=true on a commit under a tracked sourceRef', () => {
    writeDueFile('src/foo.ts', 'export const x = 1;\n');
    initGitRepo();
    const baseSha = commitAll('initial');

    const fingerprint = seedBaselineFingerprint();
    const vault = new ProjectVault(dueProjectRoot);
    writePublishedManifest(vault, fingerprint, { headSha: baseSha, maxVaultUpdatedAt: 1_783_000_000 });
    vault.writeOkfPlan({
      generatedAt: new Date().toISOString(),
      sinceRef: baseSha,
      pages: [{ path: 'concepts/foo', type: 'concept', title: 'Foo', rationale: 'r', sourceRefs: ['src/foo.ts'] }],
    });

    writeDueFile('src/foo.ts', 'export const x = 2;\n');
    commitAll('touch tracked source');

    const due = okfSynthesizeDue(
      dueScope, dueConfig(), dueProjectRoot, dueProjectId, MACHINE_ID,
      vault.readOkfManifest(), vault.readOkfPlan(),
    );
    expect(due).toBe(true);
  });

  it('a non-git project does not throw and stays gated on the vault signal alone', () => {
    const fingerprint = seedBaselineFingerprint();
    const vault = new ProjectVault(dueProjectRoot);
    // A headSha is recorded (e.g. copied from another machine's publish) but
    // this project has no .git at all — the git call inside okfSynthesizeDue
    // must fail closed to "no repo signal", not throw.
    writePublishedManifest(vault, fingerprint, { headSha: 'deadbeef', maxVaultUpdatedAt: 1_783_000_000 });
    vault.writeOkfPlan({
      generatedAt: new Date().toISOString(),
      sinceRef: 'deadbeef',
      pages: [{ path: 'concepts/foo', type: 'concept', title: 'Foo', rationale: 'r', sourceRefs: ['src/foo.ts'] }],
    });

    expect(() => okfSynthesizeDue(
      dueScope, dueConfig(), dueProjectRoot, dueProjectId, MACHINE_ID,
      vault.readOkfManifest(), vault.readOkfPlan(),
    )).not.toThrow();

    const due = okfSynthesizeDue(
      dueScope, dueConfig(), dueProjectRoot, dueProjectId, MACHINE_ID,
      vault.readOkfManifest(), vault.readOkfPlan(),
    );
    expect(due).toBe(false);
  });
});
