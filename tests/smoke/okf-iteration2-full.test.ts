import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle, OkfError } from '@myco/okf/bundle.js';
import { validateBundleTree } from '@myco/okf/validate.js';
import { parseOkfDocument } from '@myco/okf/serialize.js';
import { createOkfTools } from '@myco/agent/tools/okf-tools.js';
import { createExplorationTools } from '@myco/agent/tools/exploration-tools.js';
import { createReadTools } from '@myco/agent/tools/read-tools.js';
import { loadAgentTasks } from '@myco/agent/loader.js';
import { executeMapPhase } from '@myco/agent/map-phase.js';
import { finalizeOkfSynthesize } from '@myco/agent/executor.js';
import { OKF_SYNTHESIZE_TASK } from '@myco/agent/instruction-builders.js';
import type { PhaseDefinition } from '@myco/agent/types.js';
import type { VaultToolDeps } from '@myco/agent/tools/types.js';
import { vi } from '../helpers/vi-shim.js';

/**
 * Iteration-2 full-flow smoke: enable → run `okf-synthesize` (mocked SDK
 * stream) → publish → OKF conformance (structural + semantic) → the [R2]
 * privacy-mitigation assertion → a publish-block on an unacknowledged
 * finding → acknowledge-and-publish.
 *
 * HONESTY NOTE (mirrors the plan's Task 6.1 caveat): this is RTL/handler-level
 * with a MOCKED SDK stream — it proves PLUMBING and SHAPE (the pipeline wires
 * up correctly, the bundle it emits is OKF-conformant, the privacy backstop
 * genuinely engages), never synthesis QUALITY (whether the wiki a real model
 * produces is any good). The only real synthesis-quality check is the live
 * dogfood, Task 6.3.
 *
 * PRIVACY DESIGN NOTE: `okf_read_sources` (okf/synthesis/sources.ts) reduces
 * vault rows to `{id, title, type}` summaries, but `title` is `spore.content`
 * truncated to 100 chars — NOT redacted. A short spore's raw content,
 * including any embedded machine path or session id, reaches the tool
 * surface verbatim (asserted below). So the real mitigation for §9 is
 * two-layered: (1) prompt hygiene — the synthesis prompt instructs the model
 * to summarize/paraphrase rather than copy source text verbatim, which is a
 * live-model behavior no mocked test can prove (that's Task 6.3's job; here
 * the mock plays a WELL-BEHAVED model that only writes clean, paraphrased
 * bodies) — and (2) the backstop scan (`okf/publish-eligibility.ts`'s
 * `scanStagedBundle`), which `OkfBundle`'s staged-generation `finalize()`
 * runs against every staged page and BLOCKS an unacknowledged
 * `absolute_local_path`/`raw_session_identifier` finding before it can ever
 * reach a published bundle. This test exercises layer (2) directly: a
 * document is staged with a deliberately leaking body (simulating a hygiene
 * failure) and the assertion is that the backstop blocks it — not merely
 * that a clean mock produced clean output.
 */

const PROJECT_ID = 'proj_11111111111111111111111111111111';
const AGENT_ID = 'claude-code';
const SEEDED_TIME = 1_784_000_000;

/** Machine-path-shaped + session-id-shaped string seeded into a source. */
const SEEDED_SESSION_UUID = '9f2b1e40-6a3d-4c8e-9b21-9e0d9d2a7f31';
const SEEDED_ABS_PATH = `/Users/jordan/.myco/sessions/${SEEDED_SESSION_UUID}/transcript.jsonl`;
/** A fake secret-shaped token (matches publish-eligibility.ts's github_token pattern), unrelated to the path/session-id concern above. */
const FAKE_SECRET = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

const GENERIC_ABS_PATH_RE = /\/Users\/[^/\s"']+/;
const GENERIC_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** frontmatter.ts's OKF_DOCUMENT_KEY_ORDER (not exported — the write-time contract Task 1.1/1.2 locked). */
const OKF_DOCUMENT_KEY_ORDER = ['type', 'resource', 'title', 'description', 'tags', 'timestamp'];

/** The three pages the plan phase writes, and the map phase then synthesizes. */
const PLANNED_PAGES = [
  { path: 'guides/overview', type: 'overview', title: 'Project Overview', rationale: 'Reader entry point.', sourceRefs: ['decision-lock'] },
  { path: 'decisions/async-lock', type: 'decision', title: 'Async Lock For Staged Generation', rationale: 'Key architectural decision.', sourceRefs: ['decision-lock'] },
  { path: 'gotchas/session-artifacts', type: 'gotcha', title: 'Session Artifact Handling', rationale: 'Operational lesson generalized from a captured gotcha.', sourceRefs: ['gotcha-leak'] },
];

/** Clean, paraphrased bodies a WELL-BEHAVED model writes — never the raw seeded path/session id. */
const CLEAN_BODIES: Record<string, { description: string; body: string }> = {
  'guides/overview': {
    description: 'A reader-facing entry point summarizing the project.',
    body: 'This wiki synthesizes vault decisions and gotchas into a portable project overview. See the decisions section for the key architectural choices.',
  },
  'decisions/async-lock': {
    description: 'Why staged generation holds a single async lock across a run.',
    body: 'Staged generation acquires a lifecycle lock once per run so concurrent publishers cannot corrupt the bundle. Every page in a run publishes atomically together.',
  },
  'gotchas/session-artifacts': {
    description: 'A generalized lesson about session-scoped artifacts leaking into captured output.',
    body: 'Session-scoped artifacts (transcripts, per-run identifiers) can end up captured verbatim in logs. Treat any machine-local path or raw session identifier as sensitive and keep it out of anything meant to be published.',
  },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = path.resolve(__dirname, '..', '..', 'packages', 'myco', 'src', 'agent', 'definitions');

async function invoke(t: { handler: (args: unknown) => Promise<unknown> }, args: Record<string, unknown>): Promise<any> {
  const result = (await t.handler(args)) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0].text);
}

/** Every `.md` file under a bundle root, walked deterministically. */
function walkMarkdown(root: string): Array<{ relPath: string; content: string }> {
  const out: Array<{ relPath: string; content: string }> = [];
  const walk = (relDir: string): void => {
    const absDir = relDir === '' ? root : path.join(root, relDir);
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      out.push({ relPath, content: fs.readFileSync(path.join(root, relPath), 'utf8') });
    }
  };
  walk('');
  return out;
}

/** OKF frontmatter must use the canonical key subset/order, carry the four-key floor, and no `myco_*` keys. */
function assertOkfDocumentShape(raw: string, bundlePath: string): void {
  const parsed = parseOkfDocument(raw, bundlePath);
  const keys = Object.keys(parsed.frontmatter);
  expect(keys).toEqual(OKF_DOCUMENT_KEY_ORDER.filter((k) => keys.includes(k)));
  for (const required of ['type', 'title', 'description', 'timestamp'] as const) {
    expect(parsed.frontmatter[required]).toBeTruthy();
  }
  expect(keys.some((k) => k.startsWith('myco'))).toBe(false);
}

describe('OKF Iteration 2 — full-flow smoke (conformance + privacy + naive-block)', () => {
  let rootDir: string;
  let vaultDir: string;
  let projectRoot: string;
  let groveDbPath: string;
  let groveId: string;
  let ctx: MycoRequestContext;
  let deps: VaultToolDeps;
  let synthesizePhase: PhaseDefinition;
  let outputRoot: string;

  function seedGroveDb(seed: () => void): void {
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    const db = openDatabase(groveDbPath);
    createSchema(db);
    withDatabase(db, seed);
    db.close();
    initDatabase(groveDbPath);
  }

  function openBundle(): OkfBundle {
    return new OkfBundle({
      projectRoot,
      vault: new ProjectVault(projectRoot),
      scope: projectScopeFromRequestContext(ctx),
      projectId: PROJECT_ID,
      machineId: 'machine-a',
      config: loadMergedConfig(vaultDir, { groveId }),
    });
  }

  /** Assert no machine-path/session-id-shaped string appears anywhere in the published tree — the [R2] privacy-mitigation assertion. */
  function assertPublishedTreeIsClean(exclude: Set<string> = new Set()): void {
    const files = walkMarkdown(outputRoot).filter((f) => !exclude.has(f.relPath));
    expect(files.length).toBeGreaterThan(0);
    for (const { content } of files) {
      expect(content).not.toContain(SEEDED_ABS_PATH);
      expect(content).not.toContain(SEEDED_SESSION_UUID);
      expect(content).not.toMatch(GENERIC_ABS_PATH_RE);
      expect(content).not.toMatch(GENERIC_UUID_RE);
    }
  }

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-iter2-')));
    const home = path.join(rootDir, 'home');
    projectRoot = path.join(rootDir, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    outputRoot = path.join(projectRoot, 'okf');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    // --- enable ---
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nokf:\n  enabled: true\n');

    const grove = createGrove('Work', home);
    groveId = grove.id;
    saveProjectManifest(vaultDir, {
      project: { id: PROJECT_ID, name: 'okf-iter2' },
      grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-iter2', projectRoot, bindingId: 'g' }, home);
    groveDbPath = resolveGroveDbPath(grove.id, home);

    ctx = resolveLegacyRequestContext(vaultDir, {
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId: grove.id,
      machineId: 'machine-a',
      tenancySource: 'caller',
    });

    seedGroveDb(() => {
      registerAgent({ id: AGENT_ID, name: 'A', created_at: SEEDED_TIME });
      // A normal decision — clean source material.
      insertSpore({
        id: 'decision-lock', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision',
        content: 'We chose an async lock for staged generation so concurrent publishers cannot corrupt the bundle.',
        importance: 5, created_at: SEEDED_TIME, machine_id: 'machine-a',
      });
      // A gotcha whose raw content carries a machine-path + session-id-shaped
      // string — realistic (a captured debugging note), and short enough that
      // okf_read_sources's truncation doesn't cut it off, proving the
      // source-read layer really does carry it verbatim.
      insertSpore({
        id: 'gotcha-leak', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'gotcha',
        content: `Debugging note: saw ${SEEDED_ABS_PATH} appear in a captured log line.`,
        importance: 4, created_at: SEEDED_TIME, machine_id: 'machine-a',
      });
      insertRun({ id: 'run-okf-iter2', project_id: PROJECT_ID, agent_id: AGENT_ID, task: OKF_SYNTHESIZE_TASK, status: 'running', started_at: SEEDED_TIME });
    });

    deps = {
      agentId: AGENT_ID,
      runId: 'run-okf-iter2',
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

  it('walks enable → synthesize → publish → conformance → privacy mitigation → publish-block → acknowledge', async () => {
    // The synthesize map phase resolves its sink + item.readTools from the full
    // registry; the explore/synthesize surfaces now carry the code/vault
    // exploration read tools, so include them alongside the okf tools here.
    const tools = [...createOkfTools(deps), ...createExplorationTools(deps), ...createReadTools(deps)];
    const readSources = tools.find((t) => t.name === 'okf_read_sources')!;
    const writePlan = tools.find((t) => t.name === 'okf_write_plan')!;

    // --- explore: read-only source survey ---
    const sources = await invoke(readSources, {});
    expect(sources.error).toBeUndefined();
    // Sanity check on the privacy design note above: sources are summarized by
    // truncation only, never redacted — the seeded leak text IS visible here.
    // This is exactly why the assertions below check the PUBLISHED output and
    // the backstop scan, not this source-read tool.
    expect(JSON.stringify(sources)).toContain(SEEDED_SESSION_UUID);

    // --- plan: a small, realistic 3-page plan ---
    const planResult = await invoke(writePlan, { pages: PLANNED_PAGES });
    expect(planResult.ok).toBe(true);
    expect(planResult.pageCount).toBe(3);

    // --- synthesize (map): a WELL-BEHAVED mocked model writes clean, paraphrased bodies ---
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async (input: any) => {
        const sink = input.toolSurface.tools.find((t: any) => t.name === 'okf_write_page');
        const itemPath = input.prompt.match(/Path: (\S+)/)![1];
        const content = CLEAN_BODIES[itemPath];
        if (!content) throw new Error(`no clean body fixture for ${itemPath}`);
        await sink.handler(content);
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
    expect(mapResult.failed).toBe(0);

    // --- executor finalize: publish the staged tree once ---
    await finalizeOkfSynthesize({ agentId: deps.agentId, runId: deps.runId, requestContext: ctx, vaultDir });

    // --- status reflects it ---
    let bundle = openBundle();
    let status = bundle.status();
    expect(status.bundleExists).toBe(true);
    expect(status.bundleGeneration).toBe(1);
    expect(status.pageCount).toBe(3);

    // --- conformance: strict structural validation ---
    let conformance = validateBundleTree(outputRoot, 'strict');
    expect(conformance.ok).toBe(true);
    expect(conformance.filesChecked).toBeGreaterThan(0);

    // --- semantic reference-shape conformance (parse + structural compare, not byte-diff) ---
    const pages = bundle.listPages().map((p) => p.path).sort();
    expect(pages).toEqual(['decisions/async-lock.md', 'gotchas/session-artifacts.md', 'guides/overview.md']);
    for (const p of pages) {
      const page = bundle.readPage(p)!;
      assertOkfDocumentShape(page.raw, p);
    }
    const rootIndexRaw = fs.readFileSync(path.join(outputRoot, 'index.md'), 'utf8');
    expect(rootIndexRaw.startsWith('---')).toBe(false); // OKF indexes carry no frontmatter
    expect(rootIndexRaw).toMatch(/^# /);

    // --- [R2] privacy-mitigation assertion: the published bundle carries
    // ZERO machine-path/session-id-shaped strings, even though the source
    // material (the gotcha spore above) contained one and was fully visible
    // to the synthesis tool surface. ---
    assertPublishedTreeIsClean();

    // -----------------------------------------------------------------
    // Backstop exercise: a document DELIBERATELY leaks the seeded path —
    // simulating a hygiene failure — and the backstop scan must block it
    // before it ever reaches a published bundle.
    // -----------------------------------------------------------------
    bundle = openBundle();
    const leakStaged = await bundle.beginStagedGeneration({ mode: 'published' });
    leakStaged.stageDocument({
      path: 'gotchas/leak-attempt.md',
      frontmatter: { type: 'gotcha', title: 'Leak Attempt', description: 'Simulates a prompt-hygiene failure.', timestamp: new Date().toISOString() },
      body: `A model that ignored prompt hygiene might write the raw path: ${SEEDED_ABS_PATH}`,
    });
    // The session UUID inside the leaked path is REWRITTEN at stage time
    // (structural sanitization — no raw_session_identifier finding fires);
    // the absolute local path is deliberately NOT auto-scrubbed and blocks
    // the publish for human inspection.
    let leakError: unknown;
    try {
      await leakStaged.finalize({ inputsHash: 'leak-attempt' });
    } catch (err) {
      leakError = err;
    }
    if (!(leakError instanceof OkfError)) throw new Error(`expected OkfError, got ${String(leakError)}`);
    expect(leakError.code).toBe('okf_publish_not_acknowledged');
    const leakFindings = (leakError.details as { findings: Array<{ code: string; path: string }> }).findings;
    expect(leakFindings.some((f) => f.code === 'absolute_local_path' && f.path === 'gotchas/leak-attempt.md')).toBe(true);
    expect(leakFindings.some((f) => f.code === 'raw_session_identifier')).toBe(false);

    // Blocked, not published — the failed finalize wiped the staging dir and
    // released the lock; the previously published (clean) bundle is untouched.
    expect(openBundle().status().bundleGeneration).toBe(1);
    assertPublishedTreeIsClean();

    // -----------------------------------------------------------------
    // Publish-block + acknowledge, at the flow/handler level (task 4.1
    // already covers the RTL click flow — this exercises the underlying
    // staged-generation finalize() directly). A DISTINCT finding (a
    // secret-shaped token, unrelated to the path/session-id concern above)
    // so the acknowledge-and-publish path is proven independently.
    // -----------------------------------------------------------------
    bundle = openBundle();
    const secretDoc = {
      path: 'notes/rotated-token.md',
      frontmatter: { type: 'note', title: 'Rotated Token', description: 'A token that needs acknowledging before publish.', timestamp: new Date().toISOString() },
      body: `Historical note: the old deploy token looked like ${FAKE_SECRET} before rotation.`,
    };
    const secretStaged = await bundle.beginStagedGeneration({ mode: 'published' });
    secretStaged.stageDocument(secretDoc);
    await expect(secretStaged.finalize({ inputsHash: 'secret-attempt' })).rejects.toMatchObject({
      code: 'okf_publish_not_acknowledged',
      details: {
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'likely_secret', path: 'notes/rotated-token.md' }),
        ]),
      },
    });
    expect(openBundle().status().bundleGeneration).toBe(1);

    // Acknowledge & retry — the failed finalize wiped the staging dir, so a
    // fresh session re-stages the same document with acknowledgePublish set.
    bundle = openBundle();
    const ackStaged = await bundle.beginStagedGeneration({ mode: 'published', acknowledgePublish: true });
    ackStaged.stageDocument(secretDoc);
    const published = await ackStaged.finalize({ inputsHash: 'secret-attempt-ack' });
    expect(published.publishEligibility.ok).toBe(false); // the finding existed; acknowledging doesn't erase it, it overrides the block
    status = openBundle().status();
    expect(status.bundleGeneration).toBe(2);
    expect(status.pageCount).toBe(4);
    expect(openBundle().readPage('notes/rotated-token.md')?.raw).toContain(FAKE_SECRET);

    // Structural conformance still holds — validate.ts checks shape, never secrets.
    conformance = validateBundleTree(outputRoot, 'strict');
    expect(conformance.ok).toBe(true);

    // The privacy invariant still holds for every OTHER page — the
    // acknowledged finding here is a distinct secret-shaped token, never a
    // path/session-id leak.
    assertPublishedTreeIsClean(new Set(['notes/rotated-token.md']));
  });
});
