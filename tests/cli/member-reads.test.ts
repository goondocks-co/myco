/**
 * The retained read verbs in a joined project with no 1.4 vault: `search`,
 * `vectors`, `session` and `stats` answer from the Deployment the membership
 * names, over the in-process worker, and leave no vault, Grove, daemon state or
 * database behind on the machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { run as runRead, STATUS_READ_PATH } from '@myco/cli/member-reads.js';
import { MEMBER_TOKEN_BYTE_QUOTA, SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { latestOutcome, runMaintenance } from '@myco-server-worker/core/store-maintenance.js';
import { DAILY_QUOTA_UNAVAILABLE, SIZE_LIMIT_UNAVAILABLE } from '@myco-server-worker/platform/cloudflare/store-maintenance.js';
import { memberSource as memberReadSource, type MemberVerbDeps as MemberReadDeps } from '@myco/cli/deployment-reader.js';
import { MEMBER_READ_VERBS, type MemberReadVerb } from '@myco/cli/member-verbs.js';
import { callTool } from '@myco/mcp/client-call.js';
import { deploymentTransport, resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { REJOIN_HINT } from '@myco/member/delivery-notice.js';
import { readRegistryEntry } from '@myco/member/registry.js';
import { memberRig, tempMycoHome, type MemberRig } from '../member/helpers/server.js';
import { recordingFetch, registerTestMember, runHook } from '../member/helpers/hooks.js';
import type { FetchLike } from '@myco/member/transport.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_URL = 'https://member-test.invalid';
const PROJECT = 'proj_1';

let mycoHome: string;
let checkout: string;
const savedHome = process.env.MYCO_HOME;

/** A fresh Git checkout: no `.myco/`, no `myco.yaml`, nothing of a 1.4 install. */
function freshCheckout(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-reads-')));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  checkout = freshCheckout();
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

/** What a 1.4 install leaves on a machine: a project vault, a Grove, daemon state, a SQLite file. */
function legacyArtifacts(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === '.git') continue;
      if (['.myco', 'groves', 'daemon.json', 'daemon.lock', 'service', 'myco.yaml'].includes(entry.name)) found.push(full);
      else if (/\.(db|sqlite)(-wal|-shm)?$/.test(entry.name)) found.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(checkout);
  walk(mycoHome);
  return found;
}

/** Join the checkout (and the hooks' own root, which captures the seed session) to the rig's Deployment. */
function join(rig: Pick<MemberRig, 'token' | 'tokenId' | 'expiresAt'>): void {
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL, root: checkout });
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
}

/** One captured session on the Deployment, through the real hooks, parsed. */
async function seedSession(rig: MemberRig, sessionId: string, text: string): Promise<void> {
  const tx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-reads-tx-')), `${sessionId}.jsonl`);
  fs.writeFileSync(tx, [
    { type: 'user', cwd: '/work/repo', promptId: `p-${sessionId}`, uuid: `u-${sessionId}`, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } },
    { type: 'assistant', uuid: `a-${sessionId}`, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: `re: ${text}` }], stop_reason: 'end_turn' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  await runHook('session-start', { session_id: sessionId, hook_event_name: 'SessionStart', transcript_path: tx, cwd: '/work/repo' }, { fetch: rig.fetch });
  await runHook('stop', { session_id: sessionId, hook_event_name: 'Stop', transcript_path: tx, last_assistant_message: `re: ${text}` }, { fetch: rig.fetch });
  await runHook('session-end', { session_id: sessionId, hook_event_name: 'SessionEnd', transcript_path: tx }, { fetch: rig.fetch });
  for (let pass = 0; pass < 20; pass += 1) if ((await parseTranscripts(rig.env.serverEnv, Date.now())) === 0) break;
}

/** A spore on the Deployment, saved through the same served tool an agent calls. */
async function seedSpore(fetchImpl: FetchLike, content: string): Promise<void> {
  const upstream = resolveDeploymentUpstream('registry', { cwd: checkout, env: process.env, mycoHome })!;
  const saved = await callTool(deploymentTransport(upstream, {}, fetchImpl), 'myco_spores', { op: 'save', project: PROJECT, type: 'discovery', content });
  expect(saved.ok).toBe(true);
}

interface Ran { ok: boolean; stdout: string; stderr: string }

async function read(verb: MemberReadVerb, args: string[], fetchImpl: FetchLike, extra: Partial<MemberReadDeps> = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: MemberReadDeps = { cwd: checkout, mycoHome, fetch: fetchImpl, stdout: (l) => out.push(l), stderr: (l) => err.push(l), ...extra };
  const source = memberReadSource(args, deps);
  expect(source).toBe('registry');
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as never;
  try {
    const ok = await runRead(verb, args, source!, deps);
    return { ok, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    (process.stderr as unknown as { write: unknown }).write = origErr;
  }
}

describe('the retained read verbs in a joined project with no 1.4 vault', () => {
  it('route to the Deployment only for a root the registry holds a membership for, or a declared credential source', async () => {
    const rig = await memberRig();
    const elsewhere = freshCheckout();
    expect(memberReadSource([], { cwd: checkout, mycoHome })).toBeNull();
    join(rig);
    expect(memberReadSource([], { cwd: checkout, mycoHome })).toBe('registry');
    expect(memberReadSource([], { cwd: elsewhere, mycoHome })).toBeNull();
    expect(memberReadSource(['--credential', 'env'], { cwd: elsewhere, mycoHome })).toBe('env');
    expect(() => memberReadSource(['--credential', 'daemon'], { cwd: elsewhere, mycoHome })).toThrow();
    expect(resolveMemberProjectRoot(checkout)).toBe(checkout);
  });

  it('search answers from the Deployment\'s project intelligence', async () => {
    const rig = await memberRig();
    join(rig);
    await seedSpore(rig.fetch, 'the zanzibar cache is rebuilt from the deployment on every join');

    const ran = await read('search', ['zanzibar'], rig.fetch);

    expect(ran.stderr).toBe('');
    expect(ran.ok).toBe(true);
    expect(ran.stdout).toContain(`Deployment: ${SERVER_URL}  project: ${PROJECT}`);
    expect(ran.stdout).toContain('[spore] the zanzibar cache is rebuilt');
    expect(legacyArtifacts()).toEqual([]);
  });

  it('session latest, a full id and a short id answer the Deployment\'s session', async () => {
    const rig = await memberRig();
    join(rig);
    await seedSession(rig, 'sess-deployment-one', 'find the flaky shard');

    for (const arg of [[], ['latest'], ['sess-deployment-one'], ['sess-deploy']]) {
      const ran = await read('session', arg, rig.fetch);
      expect(ran.stderr).toBe('');
      expect(ran.ok).toBe(true);
      expect(ran.stdout).toContain(`Deployment: ${SERVER_URL}  project: ${PROJECT}`);
      expect(ran.stdout).toContain('Session: sess-deployment-one');
      expect(ran.stdout).toContain('Prompts: 1');
    }
    const missing = await read('session', ['sess-nowhere'], rig.fetch);
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toContain(`no session sess-nowhere on ${SERVER_URL}`);
    expect(legacyArtifacts()).toEqual([]);
  });

  it('stats reports the Deployment\'s project and health, not a local vault', async () => {
    const rig = await memberRig();
    join(rig);
    await seedSession(rig, 'sess-stats', 'count me');
    const spy = recordingFetch(rig.fetch);

    const ran = await read('stats', [], spy.fetch);

    expect(ran.stderr).toBe('');
    expect(ran.ok).toBe(true);
    expect(ran.stdout).toContain(`Deployment: ${SERVER_URL}`);
    expect(ran.stdout).toContain(`Target:     ${rig.env.serverEnv.platform.name}`);
    expect(ran.stdout).toContain(`Project:    ${PROJECT}`);
    expect(ran.stdout).toContain('Sessions:      1');
    expect(ran.stdout).toContain('Active:        yes');
    const bytes = (n: number) => `${n.toLocaleString('en-US')} bytes`;
    const tokenId = readRegistryEntry(checkout, mycoHome)!.tokenId;
    const charged = (rig.env.sqlite.query('SELECT bytes_written FROM member_credentials WHERE id = ?').get(tokenId) as { bytes_written: number }).bytes_written;
    const blobs = (rig.env.sqlite.query('SELECT COALESCE(SUM(size), 0) AS n FROM blobs').get() as { n: number }).n;
    expect(charged).toBeGreaterThan(0);
    expect(ran.stdout).toContain(`Schema:     expected ${SERVER_SCHEMA_VERSION}, found ${SERVER_SCHEMA_VERSION}\n`);
    expect(ran.stdout).toContain(`Quota:      ${bytes(charged)} used of ${bytes(MEMBER_TOKEN_BYTE_QUOTA)} (this machine's credential)`);
    expect(ran.stdout).toContain(`Blobs:      ${bytes(blobs)}`);
    expect(ran.stdout).toContain('Database:   unavailable: no store maintenance check has finished yet; the database is measured when one runs');
    expect(spy.requests.filter((r) => r.path === STATUS_READ_PATH).map((r) => r.body)).toEqual(['{}']);
    expect(ran.stdout).not.toContain('Vault');
    expect(legacyArtifacts()).toEqual([]);
  });

  it('stats shows every database measurement store maintenance recorded, each one the target cannot report named with why', async () => {
    const rig = await memberRig();
    join(rig);
    const ran = await runMaintenance(rig.env.serverEnv, 'optimize', 'owner', Date.now());
    expect(ran.outcome).toBe('ran');
    const recorded = (await latestOutcome(rig.env.serverEnv, 'optimize'))!;

    const stats = await read('stats', [], rig.fetch);

    expect(stats.ok).toBe(true);
    expect(stats.stdout).toContain('Database:   unavailable: D1 reported no size for this query');
    expect(stats.stdout).toContain(`Size limit: unavailable: ${SIZE_LIMIT_UNAVAILABLE}`);
    expect(stats.stdout).toContain(`Daily quota: unavailable: ${DAILY_QUOTA_UNAVAILABLE}`);
    expect(stats.stdout).toContain(`measured by store maintenance at ${new Date(recorded.finishedAt!).toISOString()}`);
  });

  it('vectors asks the Deployment for semantic search and names the Deployment that cannot serve it', async () => {
    const rig = await memberRig();
    join(rig);
    const spy = recordingFetch(rig.fetch);

    const ran = await read('vectors', ['anything'], spy.fetch);

    expect(ran.ok).toBe(false);
    expect(ran.stderr).toContain(`semantic search is unavailable on ${SERVER_URL}`);
    const calls = spy.requests.filter((r) => r.path === '/mcp' && r.body?.includes('tools/call'));
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain('"mode":"semantic"');
    expect(legacyArtifacts()).toEqual([]);
  });

  it('renews a token that lapsed inside its lineage before the read, and answers on the successor', async () => {
    const rig = await memberRig({ now: Date.now() - 20 * DAY_MS });
    join(rig);
    expect(rig.expiresAt).toBeLessThan(Date.now());
    const spy = recordingFetch(rig.fetch);

    const ran = await read('stats', [], spy.fetch);

    expect(ran.ok).toBe(true);
    expect(spy.requests[0].path).toBe('/tokens/refresh');
    const renewed = readRegistryEntry(checkout, mycoHome)!;
    expect(renewed.token).not.toBe(rig.token);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
    const reads = spy.requests.filter((r) => r.path === '/mcp');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.headers.authorization === `Bearer ${renewed.token}`)).toBe(true);
  });

  it('renews once after a refusal of an unchanged credential, and names the recovery when the credential is finished', async () => {
    const rig = await memberRig();
    join(rig);
    rig.env.sqlite.query('UPDATE member_credentials SET revoked_at = ? WHERE id = ?').run(Date.now(), rig.tokenId);
    const spy = recordingFetch(rig.fetch);

    const ran = await read('stats', [], spy.fetch);

    expect(ran.ok).toBe(false);
    expect(ran.stderr).toContain(`myco stats: ${SERVER_URL} did not answer myco_cortex (unauthorized): the Deployment refused this machine's credential and it cannot be renewed — ${REJOIN_HINT}`);
    expect(spy.requests.filter((r) => r.path === '/tokens/refresh')).toHaveLength(1);
    expect(readRegistryEntry(checkout, mycoHome)!.refreshTerminal).toBe(true);
    expect(legacyArtifacts()).toEqual([]);
  });

  it('refuses a usage error for every verb before dialling anything', async () => {
    const rig = await memberRig();
    join(rig);
    const spy = recordingFetch(rig.fetch);
    for (const [verb, args] of [['search', []], ['vectors', []], ['stats', ['extra']], ['session', ['a', 'b']]] as const) {
      expect(MEMBER_READ_VERBS).toContain(verb);
      const ran = await read(verb, [...args], spy.fetch);
      expect(ran.ok).toBe(false);
      expect(ran.stderr).toContain(`Usage: myco ${verb}`);
    }
    expect(spy.requests).toEqual([]);
  });
});
