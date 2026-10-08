import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
/**
 * Which decrypted Deployment secrets leave the server on a claim.
 *
 * A claim answers a worker with the credential its harness reads, so this is
 * the surface that decides what one admin's claim discloses. The table saying
 * which provider a harness belongs to is asserted elsewhere; what is held here
 * is the code that READS it — a claim that opened every slot it holds would
 * satisfy a table assertion and disclose every provider key at once.
 */
import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { HARNESS_CREDENTIALS, credentialEnvFor } from '@goondocks/myco-shared/harness-providers';
import { harnessesReading, isSecretSlotName, SECRET_SLOTS } from '@goondocks/myco-shared/secret-slots';

const NOW = 1_800_000_000_000;
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const API_KEY = 'sk-ant-TEST-API-KEY-VALUE-0001';
const OAT = 'sk-ant-oat01-TEST-SUBSCRIPTION-TOKEN';
const OPENAI_KEY = 'sk-openai-TEST-KEY-VALUE-0002';
const CODEX_KEY = 'sk-codex-TEST-KEY-VALUE-0003';

async function fixture() {
  const e = sqliteEnv();
  turnOnGatedCapabilities(e.sqlite);
  const env = serverEnvFromBindings({ ...e.env, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } } as never);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  await ensureMember(e.db, 'mem_w', NOW, 'admin', 'a worker');
  const token = (await issueMemberToken(e.db, { memberId: 'mem_w', machineId: 'm1' }, NOW)).tokenId;
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  const settings = settingsWriter(e.db);
  for (const [harness, model] of [['codex', 'gpt-fixture'], ['opencode', 'anthropic/claude-fixture']]) {
    await settings.setLeaf(`agent.reasoning_map.${harness}.default`, model, 'mem_w', NOW);
  }
  const queue = (id: string) => e.sqlite.run(
    `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
     VALUES ('proj_1', ?, 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'do it')`,
    [id, NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
  );
  /** What a claim hands the worker for this harness, against whatever secrets the Deployment holds. */
  const claimUnder = async (harness: string, at: number, source: 'deployment' | 'worker-login' = 'deployment') => {
    await settings.setLeaf(`agent.harnesses.${harness}.credential`, source, 'mem_w', at);
    queue(`run_${harness}_${at}`);
    const outcome = await claimNextRun(env, { principal: legacyWorker(token, 'm1'), harnesses: [offeredHarness(harness)], now: at });
    expect(outcome.claimed).toBe(true);
    if (!outcome.claimed) throw new Error('unreachable');
    e.sqlite.run(`UPDATE agent_runs SET status = 'completed' WHERE id = ?`, [outcome.run.id]);
    return outcome.run.credentialEnv;
  };
  return { e, env, secrets, claimUnder };
}

describe('the run credential a claim mints (#1420)', () => {
  it('does not rotate: the worker hands it to the harness child through its environment', async () => {
    const f = await fixture();
    await settingsWriter(f.e.db).setLeaf('agent.harnesses.claude-code.credential', 'worker-login', 'mem_w', NOW);
    f.e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES ('proj_1', 'run_rot', 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'do it')`,
      [NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
    );
    const worker = (f.e.sqlite.query(`SELECT id FROM member_credentials WHERE member_id = 'mem_w'`).get() as { id: string }).id;
    const outcome = await claimNextRun(f.env, { principal: legacyWorker(worker, 'm1'), harnesses: [offeredHarness('claude-code')], now: NOW + 1 });
    expect(outcome.claimed).toBe(true);
    const dispatchedBy = (f.e.sqlite.query(`SELECT dispatched_by FROM agent_runs WHERE id = 'run_rot'`).get() as { dispatched_by: string }).dispatched_by;
    expect(f.e.sqlite.query(`SELECT member_id, rotates FROM member_credentials WHERE id = ?`).get(dispatchedBy)).toEqual({ member_id: HARNESS_MEMBER_ID, rotates: 0 });
  });
});

describe('the credential a claim hands a worker', () => {
  it('never supplies an Anthropic subscription token as another agent API key', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', OAT, 'mem_w', NOW);
    expect(credentialEnvFor('opencode', OAT)).toEqual({});
    expect(credentialEnvFor('cursor', OAT)).toEqual({});
    expect(await f.claimUnder('opencode', NOW + 1, 'worker-login')).toEqual({});
  });

  it('opens the chosen harness\'s own provider and no other, whatever else the Deployment holds', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', API_KEY, 'mem_w', NOW);
    await f.secrets.put('codex', CODEX_KEY, 'mem_w', NOW);
    await f.secrets.put('openai', OPENAI_KEY, 'mem_w', NOW);
    await f.secrets.put('openrouter', 'sk-or-TEST-KEY', 'mem_w', NOW);

    // A harness gets its own slot's key alone. A claim answering every slot the
    // Deployment holds would put every provider's key in one answer.
    expect(await f.claimUnder('claude-code', NOW + 1)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
    expect(await f.claimUnder('codex', NOW + 2)).toEqual({ OPENAI_API_KEY: CODEX_KEY });
    expect(await f.claimUnder('opencode', NOW + 3)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
    expect(credentialEnvFor('cursor', API_KEY)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
  });

  it('never hands a Codex run the key stored for embeddings, and hands it the key stored for Codex runs (#1212)', async () => {
    const f = await fixture();
    expect(await f.claimUnder('codex', NOW + 1, 'worker-login')).toEqual({});
    // An OpenAI key stored for embeddings changes nothing a Codex claim answers: the run keeps the worker's own login.
    await f.secrets.put('openai', OPENAI_KEY, 'mem_w', NOW);
    expect(await f.claimUnder('codex', NOW + 2, 'worker-login')).toEqual({});
    // The key stored for Codex runs is the one a Codex run reads.
    await f.secrets.put('codex', CODEX_KEY, 'mem_w', NOW);
    expect(await f.claimUnder('codex', NOW + 3)).toEqual({ OPENAI_API_KEY: CODEX_KEY });
    // And removing it hands the run back to the worker's own login, not to the embedding key.
    await f.secrets.delete('codex', 'mem_w', NOW);
    expect(await f.claimUnder('codex', NOW + 4, 'worker-login')).toEqual({});
  });

  it('hands a harness on a provider the Deployment does not store nothing at all', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', API_KEY, 'mem_w', NOW);
    await f.secrets.put('openai', OPENAI_KEY, 'mem_w', NOW);
    // Antigravity authenticates against Google, which this Deployment holds no
    // slot for. It runs under its own login rather than another's key.
    expect(credentialEnvFor('antigravity', API_KEY)).toEqual({});
  });

  it('names the variable by the value: a subscription token and an API key are one slot under two names', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', OAT, 'mem_w', NOW);
    expect(await f.claimUnder('claude-code', NOW + 1)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: OAT });

    const g = await fixture();
    await g.secrets.put('anthropic', API_KEY, 'mem_w', NOW);
    expect(await g.claimUnder('claude-code', NOW + 1)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
  });

  it('hands nothing where the Deployment stores nothing, so a logged-in harness keeps its own login', async () => {
    const f = await fixture();
    // The laptop case: the harness is logged in on the machine and the
    // Deployment holds no key for it. Injecting one would override that login.
    expect(await f.claimUnder('claude-code', NOW + 1, 'worker-login')).toEqual({});
    expect(await f.claimUnder('codex', NOW + 2, 'worker-login')).toEqual({});
  });

  it('opens nothing for a harness id without a credential declaration', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', API_KEY, 'mem_w', NOW);
    await f.secrets.put('openai', OPENAI_KEY, 'mem_w', NOW);
    // A Deployment naming no preference takes what the worker offers, and a
    // worker offers only what its own manifest can drive — so an id this
    // Deployment has no row for is a harness newer than it, not a bad ask. It
    // runs under its own login: no provider slot is named for it and none is
    // opened, which is what keeps an unknown id from reaching for another
    // provider's key.
    expect(credentialEnvFor('something-else', API_KEY)).toEqual({});
  });

  it('records the harness it chose on the run, so what ran is read off the row rather than inferred', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', API_KEY, 'mem_w', NOW);
    await f.claimUnder('codex', NOW + 1, 'worker-login');
    expect(f.e.sqlite.query(`SELECT harness FROM agent_runs WHERE id = 'run_codex_${NOW + 1}'`).get()).toEqual({ harness: 'codex' });
  });
});

describe('the slots a Deployment stores keys in (#1212)', () => {
  it('gives every slot a harness reads a row of its own, and lets no harness read a slot the embedding provider reads', () => {
    const read = Object.values(HARNESS_CREDENTIALS).map((declared) => declared.slot).filter((slot) => slot !== null);
    expect(read.filter((slot) => !isSecretSlotName(slot!))).toEqual([]);
    // `configured-provider.ts` opens these for embeddings; a key stored for that is nobody's login.
    expect({ openai: harnessesReading('openai'), openrouter: harnessesReading('openrouter') }).toEqual({ openai: [], openrouter: [] });
    expect(SECRET_SLOTS.find((slot) => slot.name === 'openai')?.alsoUsedFor).toContain('embeddings');
  });
});
