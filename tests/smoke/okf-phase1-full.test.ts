import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase, withDatabase, closeDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { REQUEST_CONTEXT_ENV, projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import { assertGroveProjectId, projectScope as toProjectScope } from '@myco/grove/ids.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { run as runOkf } from '@myco/cli/okf.js';
import { run as runConfig } from '@myco/cli/config.js';
import { run as runTool } from '@myco/cli/tool.js';
import { reconcileManagedProjectFiles } from '@myco/symbionts/reconcile.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { okfMaintainDue } from '@myco/okf/schedule.js';
import { buildScheduledJobs, type ScheduledJobContext } from '@myco/daemon/task-scheduler.js';
import type { RegisteredProjectScope } from '@myco/daemon/scope-iteration.js';
import type { AgentTask } from '@myco/agent/types.js';
import { handleOkfMaintain, handleOkfStatus } from '@myco/daemon/api/okf.js';
import type { RequestPrincipal } from '@myco/daemon/request-principal.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import { vi } from '../helpers/vi-shim.js';

/**
 * Phase 1B end-to-end sandbox smoke, extending the Phase 1A smoke
 * (tests/smoke/okf-phase1a.test.ts, whose fixture setup this file mirrors
 * exactly) with the six 1B surfaces in one shared sandbox:
 *
 *   1. CLI enable + maintain (real `myco okf maintain`)
 *   2. Symbiont path — `myco_okf` MCP tool save_concept via the CLI `call` shim
 *   3. Scheduler path — `okf-maintain-due` precondition + job dispatch
 *   4. API path — daemon HTTP handlers called directly
 *   5. Conflict path — stale `expected_generation` → 409 okf_generation_conflict
 *   6. Disable path — pointer removal, precondition flips false, warnings-only
 *
 * Cortex stays disabled throughout (mirrors 1A): OKF must not depend on it.
 */

const PROJECT_ID = 'proj_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const AGENT_ID = 'claude-code';

let rootDir: string;
let home: string;
let projectRoot: string;
let vaultDir: string;
let groveId: string;
let groveDbPath: string;
let written: string[];
let originalLog: typeof console.log;
let stdoutChunks: string[];
let originalStdoutWrite: typeof process.stdout.write;

function lastJson(): Record<string, unknown> {
  return JSON.parse(written.join('\n').trim().split('\n').filter(Boolean).join('')) as Record<string, unknown>;
}

async function okf(args: string[]): Promise<Record<string, unknown>> {
  written = [];
  process.exitCode = 0;
  await runOkf(args, vaultDir);
  return lastJson();
}

/**
 * `myco tool call` writes its JSON envelope with `process.stdout.write`, not
 * `console.log` (unlike `myco okf`/`myco config`) — captured separately.
 * Returns the tool's `result` on success, or `{ ok: false, error }` shaped
 * like the CLI/API error envelopes so callers can assert on `.error` either
 * way.
 */
async function callTool(op: Record<string, unknown>): Promise<Record<string, unknown>> {
  stdoutChunks = [];
  process.exitCode = 0;
  await runTool(['call', 'myco_okf', '--json', '--input', JSON.stringify(op)], vaultDir);
  const envelope = JSON.parse(stdoutChunks.join('')) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
  if (!envelope.ok) return { ok: false, error: `${envelope.error?.code}: ${envelope.error?.message}` };
  return envelope.result as Record<string, unknown>;
}

const okfPath = (rel: string) => path.join(projectRoot, 'okf', rel);

beforeEach(() => {
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-smoke-')));
  home = path.join(rootDir, 'home');
  projectRoot = path.join(rootDir, 'project');
  vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: projectRoot });
  vi.stubEnv('MYCO_HOME', home);

  // Cortex OFF from the start — the bundle must still generate.
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\ncortex:\n  enabled: false\n');

  const grove = createGrove('Work', home);
  groveId = grove.id;
  saveProjectManifest(vaultDir, {
    project: { id: PROJECT_ID, name: 'okf-smoke' },
    grove: { binding_id: 'g', slug: grove.slug, mode: 'local' },
  });
  registerProjectInGrove(grove.id, { projectId: PROJECT_ID, projectName: 'okf-smoke', projectRoot, bindingId: 'g' }, home);
  vi.stubEnv(REQUEST_CONTEXT_ENV.projectRoot, projectRoot);
  vi.stubEnv(REQUEST_CONTEXT_ENV.projectId, PROJECT_ID);
  vi.stubEnv(REQUEST_CONTEXT_ENV.groveId, grove.id);
  vi.stubEnv(REQUEST_CONTEXT_ENV.machineId, 'machine-a');

  groveDbPath = resolveGroveDbPath(grove.id, home);
  fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
  const db = openDatabase(groveDbPath);
  createSchema(db);
  withDatabase(db, () => {
    registerAgent({ id: AGENT_ID, name: 'A', created_at: 1_783_000_000 });
    insertSpore({ id: 'decision-1', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'We chose the async lock.', importance: 5, created_at: 1_783_000_000, machine_id: 'machine-a' });
  });
  db.close();
  // okfMaintainDue's SQL aggregates read the ambient getDatabase() singleton
  // (not a passed-in handle) — pin it to the grove DB for the whole test,
  // mirroring tests/agent/okf-maintain-task.test.ts's seedGroveDb helper.
  initDatabase(groveDbPath);

  written = [];
  originalLog = console.log;
  console.log = ((...parts: unknown[]) => {
    written.push(parts.map((p) => String(p)).join(' '));
  }) as typeof console.log;

  stdoutChunks = [];
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    const cb = rest.find((a): a is (error?: Error | null) => void => typeof a === 'function');
    cb?.(null);
    return true;
  }) as typeof process.stdout.write;

  process.exitCode = 0;
});

afterEach(() => {
  console.log = originalLog;
  process.stdout.write = originalStdoutWrite;
  vi.unstubAllEnvs();
  closeDatabase();
  process.exitCode = 0;
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('OKF Phase 1B full smoke', () => {
  it('walks CLI, symbiont, scheduler, API, conflict, and disable paths in one sandbox', async () => {
    // ---------------------------------------------------------------
    // 1. CLI path — enable via the real config-set path, then maintain.
    // ---------------------------------------------------------------
    await runConfig(['set', 'okf.enabled', 'true'], vaultDir);
    expect(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf8')).toContain('okf:');

    process.exitCode = 0;
    const maintained = await okf(['maintain', '--acknowledge-publish']);
    expect(process.exitCode).toBe(0);
    expect(maintained.ok).toBe(true);
    for (const rel of ['index.md', 'log.md', '.myco-okf-maintain.json', 'guides/maintaining-this-bundle.md', 'spores/decisions/decision-1.md']) {
      expect(fs.existsSync(okfPath(rel))).toBe(true);
    }

    reconcileManagedProjectFiles(projectRoot, vaultDir, groveId);
    const agentsAfterEnable = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8');
    expect(agentsAfterEnable).toContain('okf/index.md');

    // ---------------------------------------------------------------
    // 2. Symbiont path — myco_okf MCP tool (via the CLI `call` shim) saves
    //    a concept with conflict detection wired through expected_generation.
    // ---------------------------------------------------------------
    const statusBeforeSave = await okf(['status']);
    const generationBeforeSave = (statusBeforeSave.status as { bundleGeneration: number }).bundleGeneration;
    expect(generationBeforeSave).toBe(1);

    const saveResult = await callTool({
      op: 'save_concept',
      concept_id: 'concepts/smoke-note',
      markdown: '---\ntype: Note\ntitle: Smoke Note\ndescription: Saved via the myco_okf symbiont tool.\ntags:\n  - okf\ntimestamp: 2026-07-05\nmyco_id: concepts/smoke-note\n---\n\nSaved via the symbiont path.\n',
      expected_generation: generationBeforeSave,
    });
    expect(saveResult.bundleGeneration).toBe(generationBeforeSave + 1);
    expect(fs.existsSync(okfPath('concepts/smoke-note.md'))).toBe(true);

    const listed = await callTool({ op: 'list' });
    const concepts = listed.concepts as Array<{ id: string }>;
    expect(concepts.some((c) => c.id === 'concepts/smoke-note')).toBe(true);

    // ---------------------------------------------------------------
    // 3. Scheduler path — seed a NEW source change so the fingerprint the
    //    precondition recomputes differs from the persisted one, then
    //    dispatch through the real buildScheduledJobs seam.
    // ---------------------------------------------------------------
    // `myco okf maintain` (step 1) ran through the CLI's initVaultDb, which
    // calls closeDatabase() in its cleanup and clears the ambient DB
    // singleton. okfMaintainDue's SQL aggregates read that ambient
    // getDatabase() singleton (not a passed-in handle), so it must be
    // re-pinned to the grove DB before any precondition/insertSpore call —
    // mirrors tests/agent/okf-maintain-task.test.ts's seedGroveDb pattern.
    initDatabase(groveDbPath);
    insertSpore({ id: 'decision-2', project_id: PROJECT_ID, agent_id: AGENT_ID, observation_type: 'decision', content: 'A second decision, seeded after the first maintain.', importance: 5, created_at: 1_783_000_100, machine_id: 'machine-a' });

    const config = loadMergedConfig(vaultDir, { groveId });
    const manifestBeforeDue = new ProjectVault(projectRoot).readOkfManifest();
    const scopeForScheduler = toProjectScope(assertGroveProjectId(PROJECT_ID));
    expect(
      okfMaintainDue(scopeForScheduler, config, projectRoot, PROJECT_ID, 'machine-a', manifestBeforeDue),
    ).toBe(true);

    const requestContextForScope = {
      projectRoot,
      callerRoot: null,
      projectId: assertGroveProjectId(PROJECT_ID),
      groveId,
      machineId: 'machine-a',
      sessionId: null,
      projectVaultDir: vaultDir,
      databasePath: groveDbPath,
      source: 'legacy-vault',
      tenancySource: 'caller',
    } as unknown as RegisteredProjectScope['requestContext'];

    const fakeRegisteredScope: RegisteredProjectScope = {
      grove: { id: groveId, slug: 'work' } as unknown as RegisteredProjectScope['grove'],
      groveHome: home,
      databasePath: groveDbPath,
      db: {} as RegisteredProjectScope['db'],
      project: {} as RegisteredProjectScope['project'],
      projectId: assertGroveProjectId(PROJECT_ID),
      projectRoot,
      projectVaultDir: vaultDir,
      requestContext: requestContextForScope,
    };

    const runTaskCalls: string[] = [];
    const runTaskSpy = vi.fn().mockImplementation(async (scope: RegisteredProjectScope) => {
      runTaskCalls.push(scope.projectId);
    });

    const tasks: AgentTask[] = [
      {
        name: 'okf-maintain',
        displayName: 'OKF Maintain',
        description: 'test',
        agent: 'myco-agent',
        prompt: 'test',
        isDefault: false,
        schedule: {
          enabled: true,
          intervalSeconds: 21600,
          runIn: ['idle', 'sleep'],
          preCondition: 'okf-maintain-due',
          maxRunsPerDay: 4,
        },
      } as AgentTask,
    ];

    const schedulerContext: ScheduledJobContext = {
      forEachProject: async (visit) => {
        await visit(fakeRegisteredScope);
      },
      isTaskRunning: () => false,
      setTaskRunning: vi.fn(),
      getProjectPowerState: () => 'idle',
      runTask: runTaskSpy,
      getTaskConfig: () => undefined,
      preConditions: {
        'okf-maintain-due': (scope) => {
          const manifest = new ProjectVault(scope.projectRoot).readOkfManifest();
          return okfMaintainDue(
            toProjectScope(scope.projectId),
            loadMergedConfig(scope.projectVaultDir, { groveId: scope.requestContext.groveId ?? undefined }),
            scope.projectRoot,
            scope.projectId,
            scope.requestContext.machineId,
            manifest,
          );
        },
      },
    };

    const { jobs } = buildScheduledJobs(tasks, schedulerContext);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('scheduled:tasks');

    await jobs[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(runTaskCalls).toEqual([PROJECT_ID]);

    // ---------------------------------------------------------------
    // 4. API path — call the daemon handlers directly against a real
    //    RequestPrincipal, proving the HTTP surface funnels into the same
    //    capability without going through the CLI.
    // ---------------------------------------------------------------
    const principal: RequestPrincipal = {
      identity: { machineId: 'machine-a', userId: null },
      tenancy: {
        projectVaultDir: vaultDir as RequestPrincipal['tenancy']['projectVaultDir'],
        projectId: PROJECT_ID,
        groveId,
      },
    } as RequestPrincipal;

    function apiReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
      return { params: {}, query: {}, body: undefined, pathname: '/api/okf', ...overrides } as RouteRequest;
    }

    const maintainRes = await handleOkfMaintain(
      apiReq({ body: { acknowledgePublish: true } }),
      principal,
    );
    expect(maintainRes.status).toBe(200);
    const maintainBody = maintainRes.body as { ok: boolean; result: { validation: { ok: boolean } } };
    expect(maintainBody.ok).toBe(true);
    expect(maintainBody.result.validation.ok).toBe(true);

    const statusRes = await handleOkfStatus(apiReq(), principal);
    expect(statusRes.status).toBe(200);
    const statusBody = statusRes.body as {
      bundleGeneration: number;
      enabled: boolean;
      publishEligibility: { ok: boolean };
    };
    const generationAfterApiMaintain = statusBody.bundleGeneration;
    expect(generationAfterApiMaintain).toBeGreaterThan(generationBeforeSave + 1);
    expect(statusBody.enabled).toBe(true);
    expect(statusBody.publishEligibility.ok).toBe(true);

    // ---------------------------------------------------------------
    // 5. Conflict path — a stale expected_generation must be rejected with
    //    the frozen okf_generation_conflict code, reachable via the
    //    myco_okf symbiont tool's save_concept op.
    // ---------------------------------------------------------------
    const staleResult = await callTool({
      op: 'save_concept',
      concept_id: 'concepts/stale-attempt',
      markdown: '---\ntype: Note\ntitle: Stale Attempt\ndescription: Should be rejected.\ntags:\n  - okf\ntimestamp: 2026-07-05\nmyco_id: concepts/stale-attempt\n---\n\nShould never land.\n',
      expected_generation: 0,
    });
    expect(staleResult.ok).toBe(false);
    expect(String(staleResult.error)).toContain('okf_generation_conflict');
    expect(fs.existsSync(okfPath('concepts/stale-attempt.md'))).toBe(false);

    // ---------------------------------------------------------------
    // 6. Disable path — pointer removed, precondition flips false, status
    //    reports disabled, and maintain still succeeds with Canopy absent
    //    (missing Canopy data produces warnings, never failures).
    // ---------------------------------------------------------------
    await runConfig(['set', 'okf.enabled', 'false'], vaultDir);
    reconcileManagedProjectFiles(projectRoot, vaultDir, groveId);
    const agentsAfterDisable = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8');
    expect(agentsAfterDisable).not.toContain('okf/index.md');

    const configAfterDisable = loadMergedConfig(vaultDir, { groveId });
    const manifestAfterDisable = new ProjectVault(projectRoot).readOkfManifest();
    expect(
      okfMaintainDue(scopeForScheduler, configAfterDisable, projectRoot, PROJECT_ID, 'machine-a', manifestAfterDisable),
    ).toBe(false);

    const statusAfterDisable = await handleOkfStatus(apiReq(), principal);
    const disabledBody = statusAfterDisable.body as { enabled: boolean };
    expect(disabledBody.enabled).toBe(false);

    // Re-enable to confirm maintain still succeeds with Canopy absent
    // (no cortex.canopy rows were ever seeded in this sandbox) — Canopy
    // absence must warn, not fail.
    await runConfig(['set', 'okf.enabled', 'true'], vaultDir);
    process.exitCode = 0;
    const maintainedAfterReEnable = await okf(['maintain', '--acknowledge-publish']);
    expect(process.exitCode).toBe(0);
    expect(maintainedAfterReEnable.ok).toBe(true);
  });
});
