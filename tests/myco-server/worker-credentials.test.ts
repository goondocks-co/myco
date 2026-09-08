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
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const API_KEY = 'sk-ant-TEST-API-KEY-VALUE-0001';
const OAT = 'sk-ant-oat01-TEST-SUBSCRIPTION-TOKEN';
const OPENAI_KEY = 'sk-openai-TEST-KEY-VALUE-0002';

async function fixture() {
  const e = sqliteEnv();
  const env = serverEnvFromBindings({ ...e.env, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } } as never);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  await ensureMember(e.db, 'mem_w', NOW, 'admin', 'a worker');
  const token = (await issueMemberToken(e.db, { memberId: 'mem_w', machineId: 'm1' }, NOW)).tokenId;
  const secrets = deploymentSecretStore(env.db, env.wrappingKey);
  const queue = (id: string) => e.sqlite.run(
    `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
     VALUES ('proj_1', ?, 'myco-agent', 'title-summary', 'queued', ?, 'worker', ?, ?, 'do it')`,
    [id, NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
  );
  /** What a claim hands the worker for this harness, against whatever secrets the Deployment holds. */
  const claimUnder = async (harness: string, at: number) => {
    queue(`run_${harness}_${at}`);
    const outcome = await claimNextRun(env, { tokenId: token, machineId: 'm1', harnesses: [{ id: harness, authenticated: true }], now: at });
    expect(outcome.claimed).toBe(true);
    if (!outcome.claimed) throw new Error('unreachable');
    e.sqlite.run(`UPDATE agent_runs SET status = 'completed' WHERE id = ?`, [outcome.run.id]);
    return outcome.run.credentialEnv;
  };
  return { e, env, secrets, claimUnder };
}

describe('the credential a claim hands a worker', () => {
  it('opens the chosen harness\'s own provider and no other, whatever else the Deployment holds', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', API_KEY, 'mem_w', NOW);
    await f.secrets.put('openai', OPENAI_KEY, 'mem_w', NOW);
    await f.secrets.put('openrouter', 'sk-or-TEST-KEY', 'mem_w', NOW);

    // A harness gets its provider's key alone. A claim answering every slot the
    // Deployment holds would put three providers' keys in one answer.
    expect(await f.claimUnder('claude-code', NOW + 1)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
    expect(await f.claimUnder('codex', NOW + 2)).toEqual({ OPENAI_API_KEY: OPENAI_KEY });
    expect(await f.claimUnder('opencode', NOW + 3)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
    expect(await f.claimUnder('cursor', NOW + 4)).toEqual({ ANTHROPIC_API_KEY: API_KEY });
  });

  it('hands a harness on a provider the Deployment does not store nothing at all', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', API_KEY, 'mem_w', NOW);
    await f.secrets.put('openai', OPENAI_KEY, 'mem_w', NOW);
    // Antigravity authenticates against Google, which this Deployment holds no
    // slot for. It runs under its own login rather than another's key.
    expect(await f.claimUnder('antigravity', NOW + 1)).toEqual({});
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
    expect(await f.claimUnder('claude-code', NOW + 1)).toEqual({});
    expect(await f.claimUnder('codex', NOW + 2)).toEqual({});
  });

  it('keeps a harness the Deployment does not know out of the answer entirely', async () => {
    const f = await fixture();
    await f.secrets.put('anthropic', API_KEY, 'mem_w', NOW);
    // A worker offering an id the manifest does not carry matches no
    // preference, so no run is claimed and no secret is opened for it.
    const outcome = await claimNextRun(f.env, { tokenId: (await issueMemberToken(f.env.db, { memberId: 'mem_w', machineId: 'm1' }, NOW)).tokenId, machineId: 'm1', harnesses: [{ id: 'something-else', authenticated: true }], now: NOW + 1 });
    expect(outcome).toEqual({ claimed: false, reason: 'no_work' });
  });
});
