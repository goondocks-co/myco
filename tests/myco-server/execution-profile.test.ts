import { afterEach, describe, expect, it } from 'bun:test';
import * as catalogue from '@myco-server-worker/core/task-catalogue.js';
import { claimNextRun, endLeasedRun, type OfferedHarness } from '@myco-server-worker/core/harness.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { recordTaskHolder } from '@myco-server-worker/core/runs.js';
import { recordWorkerContact } from '@myco-server-worker/core/worker-contacts.js';
import { PROFILE_HOLD_PREFIXES, credentialUnavailable, heldByWords, invalidTaskTier, noModelForTier, profileUnsupported } from '@goondocks/myco-shared/run-holds';
import { sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { resolveExecutionProfile } from '@myco-server-worker/core/execution-profile.js';
import { PROFILE_HARNESSES, REASONING_TIERS, type ProfileCapability } from '@goondocks/myco-shared/execution-profile';
import { HARNESSES } from '@myco/runner/harnesses.js';

const NOW = 1_800_000_000_000;
const OFFER = { id: 'claude-code', authenticated: true, profile: { model: 'flag' as const, efforts: ['low', 'medium', 'high', 'xhigh'] } };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

async function rig(workerLogin = true) {
  const f = sqliteEnv({ workerLogin });
  cleanups.push(() => f.sqlite.close());
  turnOnGatedCapabilities(f.sqlite);
  await ensureMember(f.db, 'mem_worker', NOW, 'admin', 'worker');
  const token = await issueMemberToken(f.db, { memberId: 'mem_worker', machineId: 'fixture' }, NOW);
  f.sqlite.run(`INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','a','built-in',1,?)`, [NOW]);
  const queue = (id: string, task = 'extract-curate') => f.sqlite.run(`INSERT INTO agent_runs
    (project_id,id,agent_id,task,status,queued_at,held_by,instruction,run_context)
    VALUES ('proj_1',?,'myco-agent',?,'queued',?,'worker','read the project','{}')`, [id, task, NOW]);
  const claim = (harnesses: readonly OfferedHarness[] = [OFFER], capabilities: readonly string[] = []) => claimNextRun(f.serverEnv, { tokenId: token.tokenId, machineId: 'fixture', harnesses, capabilities, now: NOW });
  const writer = settingsWriter(f.db);
  return { ...f, queue, claim, writer, token };
}

describe('task execution profiles', () => {
  it('renders and clears every registered execution-profile hold', async () => {
    const r = await rig();
    const cases = [
      ['unsupported', profileUnsupported('claude-code'), "waiting for a worker that can apply the execution profile for claude-code; update this machine's Myco worker if it is older"],
      ['invalid_tier', invalidTaskTier('extract-curate'), "this task's tier setting is invalid for extract-curate; correct it in Settings or reset the task tier"],
      ['missing_model', noModelForTier('opencode', 'high'), "waiting for a model for opencode's high tier in Settings"],
      ['missing_credential', credentialUnavailable('claude-code'), 'waiting for a usable server login for claude-code'],
    ] as const;
    expect(PROFILE_HOLD_PREFIXES).toHaveLength(cases.length);
    for (const [id, holder, words] of cases) {
      r.queue(id);
      r.sqlite.run('UPDATE agent_runs SET held_by=? WHERE id=?', [holder, id]);
      expect(heldByWords(holder)).toBe(words);
      expect(PROFILE_HOLD_PREFIXES.some((prefix) => holder.startsWith(prefix))).toBe(true);
    }
    await recordTaskHolder(r.db, ['extract-curate'], ['worker'], 'worker', true);
    for (const [id] of cases) {
      expect(r.sqlite.query('SELECT held_by FROM agent_runs WHERE id=?').get(id)).toEqual({ held_by: 'worker' });
    }
  });

  it('holds corrupt stored profile settings and task overrides instead of inheriting a default', async () => {
    for (const [leaf, value] of [
      ['agent.reasoning_map.claude-code.default', '{bad'],
      ['agent.effort_map.claude-code.default', '{bad'],
      ['agent.tasks', '{bad'],
      ['agent.tasks', JSON.stringify({ 'extract-curate': 'high' })],
    ]) {
      const r = await rig();
      r.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES (?,?,0,'test')`, [leaf, value]);
      r.queue('corrupt');
      expect(await r.claim()).toMatchObject({ claimed: false });
      const held = String((r.sqlite.query(`SELECT held_by FROM agent_runs WHERE id='corrupt'`).get() as { held_by: string }).held_by);
      if (leaf === 'agent.tasks') expect(held).toBe('invalid_task_tier:extract-curate');
      else expect(held).toMatch(/^(profile_unsupported|no_model_for_tier):/);
    }
  });

  it('honours the effective hosted credential default and holds a missing or unsupported server login', async () => {
    for (const configured of [false, true]) {
      const r = await rig(false);
      if (configured) await r.writer.setLeaf('agent.harnesses.claude-code.credential', 'deployment', 'mem_worker', NOW);
      r.queue('missing_credential');
      expect(await r.claim()).toMatchObject({ claimed: false });
      expect(r.sqlite.query(`SELECT held_by FROM agent_runs WHERE id='missing_credential'`).get()).toEqual({ held_by: 'credential_unavailable:claude-code' });
      await r.writer.setLeaf('agent.harnesses.claude-code.credential', 'worker-login', 'mem_worker', NOW);
      expect(await r.claim()).toMatchObject({ claimed: true, run: { credentialEnv: {} } });
    }
    const r = await rig(false);
    r.env.SECRET_WRAP_KEY = { get: async () => btoa('p'.repeat(32)) };
    await deploymentSecretStore(r.db, r.serverEnv.wrappingKey).put('anthropic', 'sk-ant-oat01-fixture', 'mem_worker', NOW);
    await r.writer.setLeaf('agent.reasoning_map.opencode.default', 'anthropic/claude-sonnet-fixture', 'mem_worker', NOW);
    r.queue('unsupported_login');
    const open = { id: 'opencode', authenticated: true, profile: { model: 'config' as const, efforts: ['medium'] } };
    expect(await r.claim([open])).toMatchObject({ claimed: false });
    expect(r.sqlite.query(`SELECT held_by FROM agent_runs WHERE id='unsupported_login'`).get()).toEqual({ held_by: 'credential_unavailable:opencode' });
  });

  it('replaces a stale profile hold with the repository capability the worker lacks', async () => {
    const r = await rig();
    r.queue('source_held', 'vault-seed');
    r.sqlite.run(`UPDATE agent_runs SET held_by='profile_unsupported:claude-code' WHERE id='source_held'`);
    expect(await r.claim()).toMatchObject({ claimed: false });
    expect(r.sqlite.query(`SELECT held_by FROM agent_runs WHERE id='source_held'`).get()).toEqual({ held_by: 'repository-checkout' });
  });

  it('does not apply a named model pin to a fallback agent', async () => {
    const r = await rig();
    await r.writer.setLeaf('agent.tasks', { 'extract-curate': { harness: 'opencode', model: 'anthropic/claude-pinned', reasoningLevel: 'high' } }, 'mem_worker', NOW);
    await r.writer.setLeaf('worker.harness_fallback', ['claude-code'], 'mem_worker', NOW);
    r.queue('fallback');
    expect(await r.claim()).toMatchObject({ claimed: true, run: { harness: 'claude-code', profile: { tier: 'high', model: 'opus', effort: 'high', sources: { model: 'default' } } } });
  });

  it('records a model mismatch while keeping actual accounting separate from the request', async () => {
    const r = await rig();
    r.queue('mismatch');
    const claim = await r.claim();
    if (!claim.claimed) throw new Error('claim refused');
    await endLeasedRun(r.serverEnv, { tokenId: r.token.tokenId, now: NOW + 1 }, {
      projectId: 'proj_1', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'failed', accountingVersion: 1,
      identity: { status: 'reported', source: 'fixture', primary: { model: 'claude-opus-fixture', provider: 'anthropic' }, models: [{ model: 'claude-opus-fixture', provider: 'anthropic', source: 'fixture', usage: null }] },
    });
    const detail = await getRunDetail(r.db, { projectId: 'proj_1' }, claim.run.id, NOW + 2, 'mem_worker');
    expect(detail?.run).toMatchObject({ requested: { model: 'sonnet' }, model: 'claude-opus-fixture', identity: { warnings: ['model_mismatch'] } });
    r.sqlite.run(`UPDATE agent_runs SET execution_overrides=? WHERE id=?`, [JSON.stringify({ requested: { ...claim.run.profile, secret: 'sk-canary' }, provider: { apiKey: 'sk-canary' } }), claim.run.id]);
    expect(JSON.stringify(await getRunDetail(r.db, { projectId: 'proj_1' }, claim.run.id, NOW + 2, 'mem_worker'))).not.toContain('sk-canary');
  });

  it('records no mismatch for an OpenCode run that reports the claimed model from the claimed provider (#1608)', async () => {
    for (const [reported, warned] of [[{ model: 'gpt-5.5', provider: 'openai' }, false], [{ model: 'big-pickle', provider: 'opencode' }, true]] as const) {
      const r = await rig();
      await r.writer.setLeaf('agent.reasoning_map.opencode.default', 'openai/gpt-5.5', 'mem_worker', NOW);
      r.queue('opencode_run');
      const claim = await r.claim([{ id: 'opencode', authenticated: true, profile: { model: 'config', efforts: ['medium'] } }]);
      if (!claim.claimed) throw new Error('claim refused');
      await endLeasedRun(r.serverEnv, { tokenId: r.token.tokenId, now: NOW + 1 }, {
        projectId: 'proj_1', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'failed', accountingVersion: 1,
        identity: { status: 'reported', source: 'session.configOptions', primary: reported, models: [{ ...reported, source: 'session.configOptions', usage: null }] },
      });
      const detail = await getRunDetail(r.db, { projectId: 'proj_1' }, claim.run.id, NOW + 2, 'mem_worker');
      expect({ requested: detail?.run.requested?.model, warned: (detail?.run.identity as { warnings?: string[] } | undefined)?.warnings?.includes('model_mismatch') === true })
        .toEqual({ requested: 'openai/gpt-5.5', warned });
    }
  });

  it('never claims an effort for an agent whose manifest allows none, so its runs never read as an effort skipped (#1608)', () => {
    const effortless = Object.entries(PROFILE_HARNESSES).filter(([, spec]) => spec.allowedEfforts.length === 0).map(([id]) => id);
    expect(effortless.length).toBeGreaterThan(0);
    const settingsFor = (harness: string, tier: string) => new Map([[`agent.reasoning_map.${harness}.${tier}`, JSON.stringify('provider/model')], ['agent.tasks', JSON.stringify({ 'extract-curate': { reasoningLevel: tier } })]]);
    const effortOf = (harness: string, capability: ProfileCapability, tier: string) => {
      const resolved = resolveExecutionProfile('extract-curate', harness, capability, settingsFor(harness, tier));
      return 'profile' in resolved ? resolved.profile.effort : 'not claimed';
    };
    for (const tier of REASONING_TIERS) {
      // The same settings claim an effort for an agent that allows one, so a refusal of the settings is not what passes here.
      expect(effortOf('opencode', HARNESSES.find((h) => h.id === 'opencode')!.profile, tier)).toBe(PROFILE_HARNESSES.opencode!.efforts[tier]);
      for (const harness of effortless) {
        for (const capability of [HARNESSES.find((h) => h.id === harness)!.profile, { model: 'config' as const, efforts: [] }]) {
          expect({ harness, tier, effort: effortOf(harness, capability, tier) }).toEqual({ harness, tier, effort: 'not claimed' });
        }
      }
    }
  });

  it('declares exactly the worker outcomes and no high default', () => {
    const tiers = (catalogue as unknown as { TASK_TIERS?: Record<string, string> }).TASK_TIERS;
    expect(tiers).toEqual({ 'title-summary': 'low', 'extract-curate': 'default', 'canopy-map': 'default', 'vault-seed': 'default' });
    expect(Object.keys(tiers ?? {}).sort()).toEqual([...catalogue.OUTCOME_TASKS].sort());
  });

  it('carries the built-in profile and records the request in the atomic claim', async () => {
    const r = await rig();
    r.queue('run_default');
    const result = await r.claim();
    expect(result.claimed).toBe(true);
    if (!result.claimed) throw new Error('claim refused');
    expect(result.run).toMatchObject({ profile: { tier: 'default', model: 'sonnet', effort: 'medium', sources: { tier: 'task', model: 'default' } } });
    const row = r.sqlite.query(`SELECT model,reasoning_level,execution_overrides FROM agent_runs WHERE id='run_default'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ model: 'sonnet', reasoning_level: 'default' });
    expect(JSON.parse(String(row.execution_overrides))).toMatchObject({ requested: (result.run as unknown as { profile: unknown }).profile, harness: 'claude-code' });
    const write = r.executed.find((sql) => /UPDATE agent_runs\s+SET status = 'running'/.test(sql));
    expect(write).toContain('execution_overrides');
  });

  it('reads changed Settings at the next claim and applies a task tier override', async () => {
    const r = await rig();
    expect(await r.writer.setLeaf('agent.reasoning_map.claude-code.low', 'claude-fixture-low', 'mem_worker', NOW)).toEqual({ applied: true });
    expect(await r.writer.setLeaf('agent.effort_map.claude-code.low', 'high', 'mem_worker', NOW)).toEqual({ applied: true });
    expect(await r.writer.setLeaf('agent.tasks', { 'extract-curate': { reasoningLevel: 'low' } }, 'mem_worker', NOW)).toEqual({ applied: true });
    r.queue('run_override');
    expect(await r.claim()).toMatchObject({ claimed: true, run: { profile: { tier: 'low', model: 'claude-fixture-low', effort: 'high', sources: { tier: 'task-override', model: 'configured' } } } });
    expect(await r.writer.setLeaf('agent.reasoning_map.claude-code.low', 'haiku', 'mem_worker', NOW + 1)).toEqual({ applied: true });
    r.queue('run_changed');
    expect(await r.claim()).toMatchObject({ claimed: true, run: { profile: { model: 'haiku' } } });
  });

  it('refuses older and unsupported offers before minting a run credential and names the hold', async () => {
    for (const offer of [{ id: 'claude-code', authenticated: true }, { ...OFFER, profile: { model: 'none' as const, efforts: ['medium'] } }]) {
      const r = await rig();
      r.queue('run_held');
      const before = r.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get();
      expect(await r.claim([offer])).toEqual({ claimed: false, reason: 'no_harness' });
      expect(r.sqlite.query(`SELECT held_by FROM agent_runs WHERE id='run_held'`).get()).toEqual({ held_by: 'profile_unsupported:claude-code' });
      expect(r.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get()).toEqual(before);
    }
  });

  it('labels every queued run of an unsupported task and leaves unchanged holds untouched', async () => {
    const r = await rig();
    for (const id of ['one', 'two', 'three', 'four']) r.queue(id);
    r.sqlite.run(`CREATE TABLE hold_writes (id TEXT)`);
    r.sqlite.run(`CREATE TRIGGER count_hold_writes AFTER UPDATE OF held_by ON agent_runs BEGIN INSERT INTO hold_writes VALUES (NEW.id); END`);
    const oldOffer = { id: 'claude-code', authenticated: true };
    expect(await r.claim([oldOffer])).toEqual({ claimed: false, reason: 'no_harness' });
    expect(r.sqlite.query(`SELECT id,held_by FROM agent_runs ORDER BY id`).all()).toEqual(
      ['four', 'one', 'three', 'two'].map((id) => ({ id, held_by: 'profile_unsupported:claude-code' })),
    );
    const writes = (r.sqlite.query(`SELECT COUNT(*) AS n FROM hold_writes`).get() as { n: number }).n;
    expect(await r.claim([oldOffer])).toEqual({ claimed: false, reason: 'no_harness' });
    expect((r.sqlite.query(`SELECT COUNT(*) AS n FROM hold_writes`).get() as { n: number }).n).toBe(writes);
  });

  it('keeps the fleet hold stable when an older worker polls beside a recently capable worker', async () => {
    const r = await rig();
    r.queue('fleet_wait');
    r.sqlite.run(`UPDATE agent_runs SET held_by='profile_unsupported:claude-code' WHERE id='fleet_wait'`);
    r.sqlite.run(`CREATE TABLE fleet_hold_writes (id TEXT)`);
    r.sqlite.run(`CREATE TRIGGER count_fleet_hold_writes AFTER UPDATE OF held_by ON agent_runs BEGIN INSERT INTO fleet_hold_writes VALUES (NEW.id); END`);
    const capable = await issueMemberToken(r.db, { memberId: 'mem_worker', machineId: 'capable' }, NOW);
    await recordWorkerContact(r.db, { credentialId: capable.tokenId, machineId: 'capable', offers: [OFFER], capabilities: [], reason: 'no_work', now: NOW });
    expect(await r.claim([{ id: 'claude-code', authenticated: true }])).toEqual({ claimed: false, reason: 'no_harness' });
    expect(r.sqlite.query(`SELECT held_by FROM agent_runs WHERE id='fleet_wait'`).get()).toEqual({ held_by: 'worker' });
    expect(await r.claim([{ id: 'claude-code', authenticated: true }])).toEqual({ claimed: false, reason: 'no_harness' });
    expect(r.sqlite.query(`SELECT COUNT(*) AS n FROM fleet_hold_writes`).get()).toEqual({ n: 1 });
  });

  it('names an invalid configured task tier as the hold', async () => {
    const r = await rig();
    r.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES ('agent.tasks',?,0,'test')`, [JSON.stringify({ 'extract-curate': { reasoningLevel: 'urgent' } })]);
    r.queue('bad_tier');
    expect(await r.claim()).toEqual({ claimed: false, reason: 'no_harness' });
    const held = (r.sqlite.query(`SELECT held_by FROM agent_runs WHERE id='bad_tier'`).get() as { held_by: string }).held_by;
    expect(held).toBe('invalid_task_tier:extract-curate');
    expect(heldByWords(held)).toContain('extract-curate');
  });

  it('keeps malformed task Settings ahead of repository capability holds across repeat polls', async () => {
    for (const value of ['{bad', JSON.stringify({ 'canopy-map': 'urgent' }), JSON.stringify({ 'canopy-map': { reasoningLevel: 'urgent' } })]) {
      const r = await rig();
      r.sqlite.run(`INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) VALUES ('agent.tasks',?,0,'test')`, [value]);
      for (const id of ['one', 'two', 'three', 'four']) r.queue(`${id}_${value.length}`, 'canopy-map');
      r.sqlite.run(`CREATE TABLE invalid_tier_writes (id TEXT)`);
      r.sqlite.run(`CREATE TRIGGER count_invalid_tier_writes AFTER UPDATE OF held_by ON agent_runs BEGIN INSERT INTO invalid_tier_writes VALUES (NEW.id); END`);
      const oldOffer = { id: 'claude-code', authenticated: true };
      expect(await r.claim([oldOffer])).toEqual({ claimed: false, reason: 'no_work' });
      expect(r.sqlite.query(`SELECT DISTINCT held_by FROM agent_runs`).all()).toEqual([{ held_by: 'invalid_task_tier:canopy-map' }]);
      expect(await r.claim([oldOffer])).toEqual({ claimed: false, reason: 'no_work' });
      expect(r.sqlite.query(`SELECT COUNT(*) AS n FROM invalid_tier_writes`).get()).toEqual({ n: 4 });
    }
  });

  it('holds an unset harness model map and falls through to a capable harness', async () => {
    const r = await rig();
    r.queue('run_open');
    const open = { id: 'opencode', authenticated: true, profile: { model: 'config' as const, efforts: ['low', 'medium', 'high'] } };
    expect(await r.claim([open])).toEqual({ claimed: false, reason: 'no_harness' });
    expect(r.sqlite.query(`SELECT held_by FROM agent_runs WHERE id='run_open'`).get()).toEqual({ held_by: 'no_model_for_tier:opencode:default' });
    expect(await r.claim([open, OFFER])).toMatchObject({ claimed: true, run: { harness: 'claude-code', profile: { model: 'sonnet' } } });
  });

  it('refuses a model pin without a harness and keeps the previous siblings', async () => {
    const r = await rig();
    const previous = { 'extract-curate': { reasoningLevel: 'low' } };
    expect(await r.writer.setLeaf('agent.tasks', previous, 'mem_worker', NOW)).toEqual({ applied: true });
    expect(await r.writer.setLeaf('agent.tasks', { 'extract-curate': { model: 'sonnet' } }, 'mem_worker', NOW)).toMatchObject({ applied: false, refusal: { reason: 'invalid_value' } });
    expect((await r.writer.leaves())['agent.tasks'].value).toEqual(previous);
    expect(await r.writer.setLeaf('agent.tasks', { 'extract-curate': { model: 'opus', harness: 'claude-code' } }, 'mem_worker', NOW)).toEqual({ applied: true });
    r.queue('run_pin');
    expect(await r.claim()).toMatchObject({ claimed: true, run: { profile: { model: 'opus', sources: { model: 'task-pin' } } } });
  });

  it('shows requested and actual models side by side after accounting', async () => {
    const r = await rig();
    r.queue('run_accounted');
    const result = await r.claim();
    if (!result.claimed) throw new Error('claim refused');
    expect(await endLeasedRun(r.serverEnv, { tokenId: r.token.tokenId, now: NOW + 1 }, {
      projectId: 'proj_1', runId: result.run.id, attemptId: result.run.attemptId, status: 'failed',
      accountingVersion: 1, identity: { status: 'reported', source: 'fixture', primary: { model: 'claude-sonnet-fixture', provider: 'anthropic' }, models: [{ model: 'claude-sonnet-fixture', provider: 'anthropic', source: 'fixture', usage: null }] },
    })).toMatchObject({ ended: true });
    const detail = await getRunDetail(r.db, { projectId: 'proj_1' }, result.run.id, NOW + 2, 'mem_worker');
    expect(detail?.run).toMatchObject({ requested: { tier: 'default', model: 'sonnet', effort: 'medium' }, model: 'claude-sonnet-fixture', identity: { status: 'reported', primary: { model: 'claude-sonnet-fixture' } } });
  });
});
