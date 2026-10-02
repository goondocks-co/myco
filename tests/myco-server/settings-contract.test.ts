/**
 * The settings contract: every live Deployment and machine leaf is bound to a policy whose consumer a production
 * entry reaches, and writing it through the real route changes what that consumer does, on every target it applies to.
 *
 * Each leaf names its consumer as a function handle exported from a module the Cloudflare Worker or the self-hosted
 * server (or, for a machine leaf, the member) imports without passing through the policy registry, so a registry entry
 * alone, a text mention or a test-only import does not count. Its behavior case drives that consumer with fakes for
 * launch, fetch and clock: unset, configured, refused, stored-invalid and reset, and asserts the observable result
 * moves with the setting and the settings surface reports the value the consumer acts on.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEPLOYMENT_TARGETS, type DeploymentTarget } from '@goondocks/myco-shared/settings-contract';
import { PROFILE_HARNESSES, CONFIGURABLE_PROFILE_HARNESSES, REASONING_TIERS, type ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { LIVE_LEAVES, SETTING_POLICIES } from '@myco-server-worker/core/settings-policies.js';
import { DEPLOYMENT_LEAF_SPECS, settingTexts } from '@myco-server-worker/core/settings.js';
import { runScheduledTasks, decideTask, scheduleLeaves, scheduledTasks, scheduleFor } from '@myco-server-worker/core/scheduled-tasks.js';
import { TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { heldBy, readDispatchLimits } from '@myco-server-worker/core/limits.js';
import { CLAIM_SETTING_LEAVES, selectWorkerExecution, type OfferedHarness } from '@myco-server-worker/core/harness.js';
import { composePromptContext, composeSessionContext, readRecallLeaves } from '@myco-server-worker/core/recall.js';
import { mapInputHash, readMapSettings } from '@myco-server-worker/core/canopy.js';
import { reconcileReleaseProvenance, releaseProvenance } from '@myco-server-worker/core/release-provenance.js';
import { agentRunRetention } from '@myco-server-worker/core/jobs-run.js';
import { recoveryScheduleOf } from '@myco-server-worker/core/recovery-schedule.js';
import { stagingPrunePolicy } from '@myco-server-worker/core/staging-retention.js';
import { backupRetentionPolicy, retentionVictims } from '@myco-server-worker/core/backup-retention.js';
import { maintenanceDue } from '@myco-server-worker/core/store-maintenance.js';
import { importPolicy } from '@myco-server-worker/core/import-policy.js';
import { handleMemberStatus } from '@myco-server-worker/api/status.js';
import { mayCreateProjects } from '@myco-server-worker/api/member-projects.js';
import { embeddingKeepsAwake } from '@myco-server-worker/core/embedding/jobs.js';
import { configuredEmbeddingProvider } from '@myco-server-worker/core/embedding/configured-provider.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { cacheMachineSettings, machineAutoJoinLeaves, machinePlanDirs } from '@myco/member/machine-settings.js';
import { MACHINE_LEAF_SPECS } from '@myco-server-worker/core/machine-settings.js';
import { closureOf, entryFiles, moduleKey, REPO_ROOT } from '../helpers/import-closure.ts';
import { seededSqlite } from './helpers/d1.js';
import { indexFixture } from './helpers/vector-index.js';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, asOwnerPut, MEMBER_PRINCIPAL, OWNER_ENV, seedMemberRoleAccount } from './helpers/owner.js';
import type { Database } from 'bun:sqlite';

const NOW = Date.now();
const DAY = 86_400_000;
const ORIGIN = 'https://s';
const WRAP = btoa('w'.repeat(32));
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'myco-server', 'src');
const MEMBER_SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');

const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(path.join(tmpdir(), 'myco-settings-contract-')); temporary.push(dir); return dir; };

/** One Deployment on one target: its environment, its store, and its own request handler. */
interface Rig {
  target: DeploymentTarget;
  env: ServerEnv;
  sqlite: Database;
  fetch(request: Request): Promise<Response>;
}

/** The fake Workers AI binding: every model answers one vector. */
const workersAi = { run: async () => ({ data: [[1, 0]] }) };

function hosted(): { sqlite: Database; env: ServerEnv } {
  const e = sqliteEnv();
  return { sqlite: e.sqlite, env: serverEnvFromBindings({ ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP }, AI: workersAi, VECTORIZE: indexFixture() }, e.deferred) };
}

function selfHosted(): { sqlite: Database; env: ServerEnv } {
  const sqlite = seededSqlite();
  return { sqlite, env: serverEnvFromBunConfig({ sqlite, blobDir: path.join(scratch(), 'blobs'), ...OWNER_ENV, SECRET_WRAP_KEY: WRAP }) };
}

function rigFor(target: DeploymentTarget): Rig {
  const recovery = {
    admission: { ready: true }, status: async () => ({ attempt: null, stage: 'idle', form: 'artifact', startedAt: null, recoverable: false, staged: null, export: null }),
  };
  const { sqlite, env: base } = target === 'cloudflare' ? hosted() : selfHosted();
  const env = { ...base, origin: ORIGIN, recovery, harnessLaunch: async () => {} } as unknown as ServerEnv;
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  const rig: Rig = { target, env, sqlite, fetch: (request) => server.handleRequest(request, env) };
  seedWorld(rig);
  return rig;
}

/** What every behavior case drives against: an active project with work to do, an embedding backlog and a release-tracked repository. */
function seedWorld(r: Rig): void {
  const q = (sql: string, ...args: unknown[]) => r.sqlite.query(sql).run(...(args as never[]));
  q(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'agent', 'built-in', 1, ?)`, NOW);
  q(`INSERT INTO spores (project_id, id, agent_id, content, observation_type, created_at) VALUES ('proj_1', 'spore_1', 'myco-agent', 'project architecture', 'decision', ?)`, NOW);
  for (const capability of ['vault_evolution', 'cortex', 'canopy']) {
    q(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', ?, 1, 0, 'test')`, capability);
  }
  const at = NOW - 3_600_000;
  q(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, ended_at) VALUES ('proj_1', 's_clock', 'machine_1', 'tok_1', ?, ?, 'claude-code', ?)`, at, at, at);
  q(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at, processed) VALUES ('proj_1', 's_clock', 'p_clock', 'e_clock', 'scheduled extraction input', 'user', 'h_clock', ?, ?, 'tok_1', ?, 0)`, at, at, at);
  seedMemberRoleAccount(r.sqlite);
}

const json = async (response: Response): Promise<Record<string, unknown>> => response.json() as Promise<Record<string, unknown>>;
const put = async (r: Rig, leaf: string, value: unknown) => r.fetch(await asOwnerPut(`/api/settings/${leaf}`, { value }));
const reset = async (r: Rig, leaf: string) => r.fetch(new Request(`https://s/api/settings/${leaf}`, { method: 'DELETE', headers: Object.fromEntries((await asOwnerPost(`/api/settings/${leaf}`)).headers) }));
async function row(r: Rig, leaf: string): Promise<Record<string, unknown>> {
  const answer = await json(await r.fetch(await asOwner('/api/settings')));
  return (answer.leaves as Array<Record<string, unknown>>).find((entry) => entry.leaf === leaf)!;
}
const storedRaw = (r: Rig, leaf: string, text: string) => r.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'historic')`).run(leaf, text);

/** A consumer: a production function, and the module under `packages/myco-server/src` (or `packages/myco/src`) that exports it. */
interface Consumer { module: string; fn: (...args: never[]) => unknown; member?: true }

/** One leaf's behavior case. */
interface BehaviorCase {
  consumer: Consumer;
  /** A value its rule admits on the target, distinct from the default the consumer applies. */
  value: (target: DeploymentTarget) => unknown;
  /** A value its rule refuses. */
  invalid: (target: DeploymentTarget) => unknown;
  /** Leaves written first, through the same route. */
  setup?: (target: DeploymentTarget) => Array<[string, unknown]>;
  /** Targets that do not offer the leaf: a write is refused there. */
  notOn?: readonly DeploymentTarget[];
  /** A stored value the rule refuses holds the consumer's work, which says why, rather than falling back to the default. */
  invalidHolds?: true;
  /** What the consumer does now, read without changing anything a later read depends on. */
  observe(r: Rig): Promise<unknown>;
}

const offer = (id: string): OfferedHarness => ({ id, authenticated: true, profile: { model: 'flag', efforts: [...PROFILE_HARNESSES[id]!.allowedEfforts] } });
const selection = async (r: Rig, task: string, offers: OfferedHarness[]) => {
  const { selected, reason } = await selectWorkerExecution(r.env, task, offers, await settingTexts(r.env.db, CLAIM_SETTING_LEAVES));
  return selected === null ? { reason } : { harness: selected.harness, model: selected.profile.model, effort: selected.profile.effort, env: Object.keys(selected.credentialEnv) };
};
const at = (module: string, fn: (...args: never[]) => unknown): Consumer => ({ module, fn });

/** The extraction schedule a Project twenty days quiet meets, decided against the leaves as the clock reads them. */
const quietDecision = async (r: Rig) => decideTask(r.env, 'proj_1', NOW - 20 * DAY, 'extract-curate', scheduleFor('extract-curate', TASK_SCHEDULE['extract-curate']!, {}), 'idle', await scheduleLeaves(r.env), NOW);
/** Runs the clock dispatched at this wake; each is removed again so the next read starts from the same state. */
async function dispatched(r: Rig): Promise<number> {
  const report = await runScheduledTasks(r.env, 'idle', NOW, ORIGIN);
  r.sqlite.run(`DELETE FROM agent_runs`);
  return report.dispatched;
}
const mapSchedule = async (r: Rig) => scheduledTasks((await scheduleLeaves(r.env)).overrides).find((t) => t.task === MAP_TASK)?.schedule ?? null;
const sessionParts = async (r: Rig, kind: 'start' | 'subagent') =>
  (await composeSessionContext(r.env.db, { projectId: 'proj_1' }, await readRecallLeaves(r.env.db), true,
    { kind, sessionId: `s_${crypto.randomUUID()}`, agentId: 'sub', now: NOW }, { preview: true })).parts.map((p) => p.kind);
const promptSkips = async (r: Rig, text: string) =>
  (await composePromptContext(r.env.db, { projectId: 'proj_1' }, await readRecallLeaves(r.env.db), true,
    { sessionId: `s_${crypto.randomUUID()}`, promptId: 'p', text, now: NOW })).skipped.concat();
const retentionRows = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, created_at: NOW - i * DAY, pinned: 0 }));

async function memberStatus(r: Rig): Promise<unknown> {
  const { token } = await issueMemberToken(r.env.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
  return ((await json(await r.fetch(memberPost(token, {}, '/members/status')))).retention as Record<string, unknown>).transcripts;
}

/** A tier's task and the profile leaf cases of one agent. */
const TIER_TASK: Readonly<Record<ReasoningTier, Array<[string, unknown]>>> = {
  low: [['agent.tasks', { 'title-summary': { reasoningLevel: 'low' } }]],
  default: [['agent.tasks', { 'title-summary': { reasoningLevel: 'default' } }]],
  high: [['agent.tasks', { 'title-summary': { reasoningLevel: 'high' } }]],
};
const MODEL_SAMPLES: Readonly<Record<string, string>> = { 'claude-code': 'claude-contract-test', codex: 'gpt-5-contract', opencode: 'openai/gpt-5-contract' };
const workerLogin = (harness: string): Array<[string, unknown]> => [[`agent.harnesses.${harness}.credential`, 'worker-login']];
const modelFor = (harness: string, tier: ReasoningTier): Array<[string, unknown]> =>
  PROFILE_HARNESSES[harness]!.models[tier] === null ? [[`agent.reasoning_map.${harness}.${tier}`, MODEL_SAMPLES[harness]!]] : [];
const harnessModule = 'core/harness.ts';

function profileCases(): Record<string, BehaviorCase> {
  const out: Record<string, BehaviorCase> = {};
  for (const harness of CONFIGURABLE_PROFILE_HARNESSES) {
    const observe = (r: Rig) => selection(r, 'title-summary', [offer(harness)]);
    for (const tier of REASONING_TIERS) {
      out[`agent.reasoning_map.${harness}.${tier}`] = {
        consumer: at(harnessModule, selectWorkerExecution), invalidHolds: true, observe,
        setup: () => [...TIER_TASK[tier], ...workerLogin(harness)],
        value: () => MODEL_SAMPLES[harness]!, invalid: () => '!! not a model',
      };
      const efforts = PROFILE_HARNESSES[harness]!.allowedEfforts;
      out[`agent.effort_map.${harness}.${tier}`] = {
        consumer: at(harnessModule, selectWorkerExecution), invalidHolds: true, observe,
        setup: () => [...TIER_TASK[tier], ...workerLogin(harness), ...modelFor(harness, tier)],
        value: () => efforts.find((e) => e !== PROFILE_HARNESSES[harness]!.efforts[tier])!, invalid: () => 'warp',
      };
    }
    out[`agent.harnesses.${harness}.credential`] = {
      consumer: at(harnessModule, selectWorkerExecution), invalidHolds: true, observe,
      setup: () => [...TIER_TASK.default, ...modelFor(harness, 'default')],
      value: (target) => target === 'cloudflare' ? 'worker-login' : 'deployment', invalid: () => 'nobody',
    };
  }
  return out;
}

/** Every live Deployment leaf's consumer and behavior case. */
const CASES: Readonly<Record<string, BehaviorCase>> = {
  'agent.scheduled_tasks_enabled': { consumer: at('core/scheduled-tasks.ts', runScheduledTasks), value: () => true, invalid: () => 'yes', observe: dispatched },
  'agent.scheduled_tasks_active_window_days': {
    consumer: at('core/scheduled-tasks.ts', decideTask), setup: () => [['agent.scheduled_tasks_enabled', true]],
    value: () => 30, invalid: () => 2.5, observe: quietDecision,
  },
  'agent.cold_project_threshold_days': {
    consumer: at('core/scheduled-tasks.ts', decideTask), setup: () => [['agent.scheduled_tasks_enabled', true], ['agent.scheduled_tasks_active_window_days', 30]],
    value: () => 30, invalid: () => 2.5, observe: quietDecision,
  },
  'cortex.canopy.refresh.background_enabled': {
    consumer: at('core/scheduled-tasks.ts', scheduledTasks), value: () => true, invalid: () => 'yes', observe: async (r) => (await mapSchedule(r))?.enabled ?? null,
  },
  'cortex.canopy.refresh.background_period_minutes': {
    consumer: at('core/scheduled-tasks.ts', scheduledTasks), setup: () => [['cortex.canopy.refresh.background_enabled', true]],
    value: () => 30, invalid: () => 2.5, observe: async (r) => (await mapSchedule(r))?.intervalSeconds ?? null,
  },
  'agent.tasks': {
    consumer: at('core/scheduled-tasks.ts', scheduledTasks), value: () => ({ 'extract-curate': { schedule: { intervalSeconds: 600 } } }), invalid: () => [],
    observe: async (r) => scheduledTasks((await scheduleLeaves(r.env)).overrides).find((t) => t.task === 'extract-curate')?.schedule.intervalSeconds,
  },
  ...Object.fromEntries((['concurrent_runs', 'task_concurrent_runs', 'task_runs_per_hour'] as const).map((limit) => [`agent.limits.${limit}`, {
    consumer: at('core/limits.ts', heldBy), value: () => 2, invalid: () => 0.5,
    observe: async (r: Rig) => heldBy({ liveRuns: 5, liveTaskRuns: 5, taskRunsLastHour: 5 }, await readDispatchLimits(r.env)),
  } satisfies BehaviorCase])),
  'worker.harness': {
    consumer: at(harnessModule, selectWorkerExecution), setup: () => [...workerLogin('claude-code'), ...workerLogin('codex'), ...modelFor('codex', 'default')],
    value: () => 'codex', invalid: () => 'nobody', observe: (r) => selection(r, 'title-summary', [offer('claude-code'), offer('codex')]),
  },
  'worker.harness_fallback': {
    consumer: at(harnessModule, selectWorkerExecution), setup: () => [['worker.harness', 'opencode'], ...workerLogin('claude-code'), ...workerLogin('codex'), ...modelFor('codex', 'default')],
    value: () => ['codex'], invalid: () => ['nobody'], observe: (r) => selection(r, 'title-summary', [offer('claude-code'), offer('codex')]),
  },
  'instructions.template': {
    consumer: at('core/recall.ts', composeSessionContext), value: () => 'Use the house style.', invalid: () => 'a\u0001b', observe: (r) => sessionParts(r, 'start'),
  },
  'cortex.instructions.inject_on_session_start': {
    consumer: at('core/recall.ts', composeSessionContext), setup: () => [['instructions.template', 'Use the house style.']],
    value: () => false, invalid: () => 'no', observe: (r) => sessionParts(r, 'start'),
  },
  'cortex.instructions.inject_on_subagent_start': {
    consumer: at('core/recall.ts', composeSessionContext), setup: () => [['instructions.template', 'Use the house style.']],
    value: () => false, invalid: () => 'no', observe: (r) => sessionParts(r, 'subagent'),
  },
  'cortex.spores.inject_on_prompt_submit': {
    consumer: at('core/recall.ts', composePromptContext), value: () => false, invalid: () => 'no', observe: (r) => promptSkips(r, 'how is the project laid out'),
  },
  'cortex.spores.max_per_prompt': {
    consumer: at('core/recall.ts', composePromptContext), value: () => 0, invalid: () => 11, observe: (r) => promptSkips(r, 'how is the project laid out'),
  },
  'cortex.plans.inject_intent_nudge_on_prompt_submit': {
    consumer: at('core/recall.ts', composePromptContext), value: () => false, invalid: () => 'no', observe: (r) => promptSkips(r, 'write the implementation plan'),
  },
  'cortex.canopy.exclude.patterns': {
    consumer: at('core/canopy.ts', mapInputHash), value: () => ['dist/**'], invalid: () => [''],
    observe: async (r) => mapInputHash(await readMapSettings(r.env.db), { url: 'https://example.com/o/r.git', branch: 'main', commit: 'a'.repeat(40) }),
  },
  'release_provenance.reconcile_interval_minutes': {
    consumer: at('core/release-provenance.ts', reconcileReleaseProvenance), value: () => 30, invalid: () => 2.5,
    async observe(r) {
      const secrets = deploymentSecretStore(r.env.db, r.env.wrappingKey);
      const store = releaseProvenance(r.env.db, secrets);
      if ((await store.describe('proj_1')).revision === null) {
        await store.save('proj_1', { revision: null, enabled: true, githubRepo: 'o/r', productionRefs: ['refs/tags/v*'], integrationRefs: ['origin/main'], packageMap: [], includeUnknown: true, maxLookups: 1, credential: null }, 'test', NOW);
      }
      r.sqlite.run(`UPDATE project_release_provenance SET check_started_at = ?, check_run_id = NULL, check_lease_until = NULL, check_requested_at = NULL WHERE project_id = 'proj_1'`, [NOW - 20 * 60_000]);
      await reconcileReleaseProvenance({ ...r.env, outbound: async () => new Response('{}', { status: 404 }) }, NOW);
      return (r.sqlite.query(`SELECT check_started_at FROM project_release_provenance WHERE project_id = 'proj_1'`).get() as { check_started_at: number }).check_started_at === NOW;
    },
  },
  'agent.run_retention_days': {
    consumer: at('core/jobs-run.ts', agentRunRetention), value: () => 1, invalid: () => 0,
    async observe(r) {
      r.sqlite.run(`INSERT OR REPLACE INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, resumable) VALUES ('proj_1', 'run_old', 'myco-agent', 'title-summary', 'completed', ?, ?, 0)`, [NOW - 6 * DAY, NOW - 5 * DAY]);
      const pruned = await agentRunRetention(r.env, NOW);
      r.sqlite.run(`DELETE FROM agent_runs`);
      return pruned;
    },
  },
  'retention.transcripts': {
    consumer: at('api/status.ts', handleMemberStatus), value: () => 5, invalid: () => -1, invalidHolds: true, observe: memberStatus,
  },
  'backup.auto_interval_hours': {
    consumer: at('core/recovery-schedule.ts', recoveryScheduleOf), value: () => 6, invalid: () => 0,
    observe: async (r) => { const s = await recoveryScheduleOf(r.env, NOW); return { due: s.due, idle: s.idleCode }; },
  },
  'backup.recovery.keep_stagings': {
    consumer: at('core/staging-retention.ts', stagingPrunePolicy), value: () => 5, invalid: () => 0, observe: async (r) => (await stagingPrunePolicy(r.env)).keep,
  },
  'backup.retention.keep_daily': {
    consumer: at('core/backup-retention.ts', retentionVictims), value: () => 3, invalid: () => 0,
    observe: async (r) => { const p = await backupRetentionPolicy(r.env.db); return retentionVictims(retentionRows, p.keepDaily, p.keepWeekly).length; },
  },
  'backup.retention.keep_weekly': {
    consumer: at('core/backup-retention.ts', retentionVictims), setup: () => [['backup.retention.keep_daily', 1]], value: () => 0, invalid: () => 53,
    observe: async (r) => { const p = await backupRetentionPolicy(r.env.db); return retentionVictims(retentionRows, p.keepDaily, p.keepWeekly).length; },
  },
  ...Object.fromEntries((['optimize', 'integrity'] as const).flatMap((check) => {
    const [toggle, interval] = check === 'optimize'
      ? ['maintenance.auto_optimize', 'maintenance.auto_optimize_interval_hours'] : ['maintenance.auto_integrity_check', 'maintenance.auto_integrity_check_interval_hours'];
    const observe = (r: Rig) => maintenanceDue(r.env, check, NOW);
    return [
      [toggle, { consumer: at('core/store-maintenance.ts', maintenanceDue), setup: () => [[interval, 24]], value: () => true, invalid: () => 'yes', observe } satisfies BehaviorCase],
      [interval, { consumer: at('core/store-maintenance.ts', maintenanceDue), setup: () => [[toggle, true]], value: () => 24, invalid: () => 2.5, observe } satisfies BehaviorCase],
    ];
  })),
  'capture.auto_create_projects': {
    consumer: at('api/member-projects.ts', mayCreateProjects), value: () => false, invalid: () => 'no', observe: (r) => mayCreateProjects(r.env.db, MEMBER_PRINCIPAL.id),
  },
  'import.enabled': { consumer: at('core/import-policy.ts', importPolicy), value: () => false, invalid: () => 'no', observe: async (r) => (await importPolicy(r.env.db)).enabled },
  'import.window_days': { consumer: at('core/import-policy.ts', importPolicy), value: () => 7, invalid: () => 2.5, observe: async (r) => (await importPolicy(r.env.db)).windowDays },
  'import.max_sessions_per_harness': { consumer: at('core/import-policy.ts', importPolicy), value: () => 7, invalid: () => 2.5, observe: async (r) => (await importPolicy(r.env.db)).maxPerAgent },
  'embedding.provider': {
    consumer: at('core/embedding/configured-provider.ts', configuredEmbeddingProvider),
    value: (target) => target === 'cloudflare' ? 'openrouter' : 'ollama', invalid: (target) => target === 'cloudflare' ? 'ollama' : 'nope',
    setup: () => [], observe: providerKey,
  },
  'embedding.model': {
    consumer: at('core/embedding/configured-provider.ts', configuredEmbeddingProvider),
    setup: (target) => target === 'bun' ? [['embedding.provider', 'ollama']] : [],
    value: (target) => target === 'cloudflare' ? '@cf/baai/bge-large-en-v1.5' : 'mxbai-embed-large', invalid: () => '', observe: providerKey,
  },
  'embedding.base_url': {
    consumer: at('core/embedding/configured-provider.ts', configuredEmbeddingProvider), notOn: ['cloudflare'],
    setup: (target) => target === 'bun' ? [['embedding.provider', 'ollama']] : [],
    value: () => 'http://models.internal:11434', invalid: () => 'not a url', observe: providerKey,
  },
  'embedding.prevent_deep_sleep': {
    consumer: at('core/embedding/jobs.ts', embeddingKeepsAwake), setup: (target) => target === 'bun' ? [['embedding.provider', 'ollama']] : [],
    value: () => false, invalid: () => 'no', observe: (r) => embeddingKeepsAwake(r.env, NOW),
  },
  ...profileCases(),
};

async function providerKey(r: Rig): Promise<string | null> {
  const secrets = deploymentSecretStore(r.env.db, r.env.wrappingKey);
  if ((await secrets.describe('openrouter')).configured === false) await secrets.put('openrouter', 'or-contract-key', 'test', NOW);
  return (await r.env.embeddingProvider!())?.modelKey ?? null;
}

/** The production entries: the Worker, the self-hosted server, and the member's own entries. */
const SERVER_ENTRIES = [path.join(SERVER_SRC, 'index.ts'), path.join(SERVER_SRC, 'entry', 'bun.ts')];
const REGISTRY = moduleKey(path.join(SERVER_SRC, 'core', 'settings-policies.ts'));
const serverClosure = closureOf(SERVER_ENTRIES, { stopAt: (key) => key === REGISTRY });
const memberClosure = closureOf(entryFiles(MEMBER_SRC, ['hooks/**']));

describe('the settings contract', () => {
  it('binds every live leaf to exactly one policy, and every policy leaf is live', () => {
    const bound = SETTING_POLICIES.flatMap((policy) => policy.leaves);
    expect([...bound].sort()).toEqual([...LIVE_LEAVES].sort());
    expect(new Set(bound).size).toBe(bound.length);
  });

  it('gives every live leaf a typed rule and a behavior case', () => {
    for (const leaf of LIVE_LEAVES) {
      expect({ leaf, typed: 'type' in DEPLOYMENT_LEAF_SPECS[leaf]! }).toEqual({ leaf, typed: true });
      expect({ leaf, cased: CASES[leaf] !== undefined }).toEqual({ leaf, cased: true });
    }
    expect(Object.keys(CASES).filter((leaf) => !LIVE_LEAVES.includes(leaf))).toEqual([]);
  });

  it('reaches every consumer from a production entry without passing through the policy registry', async () => {
    for (const [leaf, { consumer }] of Object.entries(CASES)) {
      const file = path.join(SERVER_SRC, consumer.module);
      const exported = await import(file) as Record<string, unknown>;
      expect({ leaf, exported: Object.values(exported).includes(consumer.fn) }).toEqual({ leaf, exported: true });
      expect({ leaf, reached: serverClosure.modules.has(moduleKey(file)) }).toEqual({ leaf, reached: true });
    }
  });

  for (const leaf of LIVE_LEAVES) {
    for (const target of DEPLOYMENT_TARGETS) {
      it(`${leaf} on ${target}: unset, configured, refused, stored invalid and reset move the consumer`, async () => {
        const behavior = CASES[leaf]!;
        const r = rigFor(target);
        for (const [setupLeaf, setupValue] of behavior.setup?.(target) ?? []) {
          expect({ setupLeaf, status: (await put(r, setupLeaf, setupValue)).status }).toEqual({ setupLeaf, status: 200 });
        }
        const value = behavior.value(target);
        if (behavior.notOn?.includes(target)) {
          const refused = await put(r, leaf, value);
          expect(refused.status).toBe(400);
          expect(await row(r, leaf)).toMatchObject({ configured: false, appliesTo: expect.not.arrayContaining([target]) });
          return;
        }
        const before = await behavior.observe(r);
        const unset = await row(r, leaf);
        expect(unset).toMatchObject({ configured: false, state: expect.not.stringMatching(/^(invalid|not-applicable)$/) });
        expect(unset.appliesTo).toContain(target);

        expect({ leaf, written: await json(await put(r, leaf, value)) }).toEqual({ leaf, written: { applied: true } });
        const after = await behavior.observe(r);
        expect({ leaf, moved: JSON.stringify(after) !== JSON.stringify(before), before, after }).toMatchObject({ leaf, moved: true });
        const configured = await row(r, leaf);
        expect(configured).toMatchObject({ configured: true, stored: value, effective: value, source: expect.stringMatching(/^(configured|task-override)$/) });
        expect(String(configured.revision)).toStartWith('w');

        const refused = await put(r, leaf, behavior.invalid(target));
        expect({ leaf, status: refused.status, applied: (await json(refused)).applied }).toEqual({ leaf, status: 400, applied: false });
        expect((await row(r, leaf)).stored).toEqual(value);

        storedRaw(r, leaf, JSON.stringify(behavior.invalid(target)));
        const invalid = await row(r, leaf);
        expect({ leaf, state: invalid.state, reason: typeof invalid.reason }).toEqual({ leaf, state: expect.stringMatching(/^(invalid|not-applicable)$/), reason: 'string' });
        const held = await behavior.observe(r);
        if (behavior.invalidHolds) expect({ leaf, held }).toEqual({ leaf, held: expect.objectContaining({ reason: expect.any(String) }) });
        else expect({ leaf, held }).toEqual({ leaf, held: before });

        expect({ leaf, reset: await json(await reset(r, leaf)) }).toEqual({ leaf, reset: { applied: true } });
        expect({ leaf, restored: await behavior.observe(r) }).toEqual({ leaf, restored: before });
        const restored = await row(r, leaf);
        expect(restored).toMatchObject({ configured: false, effective: unset.effective, source: unset.source });
        expect(String(restored.revision)).toStartWith('r');
      });
    }
  }
});

describe('machine leaves', () => {
  const CONSUMERS: Readonly<Record<string, { fn: (...args: never[]) => unknown; module: string }>> = {
    'capture.plan_dirs': { fn: machinePlanDirs, module: 'member/machine-settings.ts' },
    'capture.auto_join_roots': { fn: machineAutoJoinLeaves, module: 'member/machine-settings.ts' },
    'capture.connect_roots': { fn: machineAutoJoinLeaves, module: 'member/machine-settings.ts' },
  };

  it('binds every machine leaf to a member consumer the member entries reach', () => {
    expect(Object.keys(CONSUMERS).sort()).toEqual(Object.keys(MACHINE_LEAF_SPECS).sort());
    for (const { module } of Object.values(CONSUMERS)) expect(memberClosure.modules.has(moduleKey(path.join(MEMBER_SRC, module)))).toBe(true);
  });

  for (const target of DEPLOYMENT_TARGETS) {
    it(`a dashboard write reaches the machine's own reading on ${target}, and a server-written leaf refuses it`, async () => {
      const r = rigFor(target);
      r.sqlite.run(`INSERT OR IGNORE INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_1', 'mem_machine_1', ?)`, [NOW]);
      const home = scratch();
      const { token } = await issueMemberToken(r.env.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
      const sync = async () => cacheMachineSettings(ORIGIN, (await json(await r.fetch(memberPost(token, {}, '/members/settings')))).machine, home);
      const set = async (leaf: string, value: unknown) => r.fetch(await asOwnerPut(`/api/machines/machine_1/settings/${leaf}`, { value }));
      await sync();
      const before = { plans: machinePlanDirs(ORIGIN, home), roots: machineAutoJoinLeaves(ORIGIN, home).autoJoinRoots };
      expect((await set('capture.plan_dirs', ['docs/plans'])).status).toBe(200);
      expect((await set('capture.auto_join_roots', ['~/Work'])).status).toBe(200);
      expect((await set('capture.plan_dirs', ['/'])).status).toBe(400);
      expect((await set('capture.connect_roots', { ['a'.repeat(64)]: 'proj_1' })).status).toBe(400);
      await sync();
      expect({ plans: machinePlanDirs(ORIGIN, home), roots: machineAutoJoinLeaves(ORIGIN, home).autoJoinRoots }).toEqual({ plans: ['docs/plans'], roots: ['~/Work'] });
      expect(before).toEqual({ plans: [], roots: ['~/Repos'] });
      expect((await set('capture.plan_dirs', [])).status).toBe(200);
      await sync();
      expect(machinePlanDirs(ORIGIN, home)).toEqual([]);
    });
  }
});
