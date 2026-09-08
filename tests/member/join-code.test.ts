/**
 * The sandbox path: one environment variable, no local configuration, and a
 * machine that captures.
 *
 * The gate #1158 names is here — a runtime holding only a join code reaches the
 * Deployment and lands a session and its plan. The second gate is the race: two
 * hooks starting together must BOTH capture, on one credential, from one
 * single-use code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { ENV_JOIN_CODE } from '@myco/member/constants.js';
import { ensureJoinedFromCode, exchangeJoinCode, parseJoinCode, JOIN_CODE_REFUSALS } from '@myco/member/join-code.js';
import { readDeploymentMembership, readRegistryEntry } from '@myco/member/registry.js';
import { unjoinedRig } from './helpers/server.js';

const KEY = 'k'.repeat(43);

describe('reading a join code', () => {
  it('splits a well-formed link into the Deployment and the invitation, and keeps the key out of the path', () => {
    expect(parseJoinCode('https://myco.example.com/join#' + KEY)).toEqual({ serverUrl: 'https://myco.example.com', key: KEY });
    expect(parseJoinCode('  https://myco.example.com/join/#' + KEY + '  ')).toEqual({ serverUrl: 'https://myco.example.com', key: KEY });
  });

  it('admits a loopback Deployment over plain http, which is where a laptop serves itself', () => {
    expect(parseJoinCode('http://127.0.0.1:8787/join#' + KEY)).toEqual({ serverUrl: 'http://127.0.0.1:8787', key: KEY });
  });

  it('names what is wrong with every link it refuses, and refuses each on the string alone', () => {
    const cases: Array<[string, keyof typeof JOIN_CODE_REFUSALS]> = [
      ['not a url at all', 'not_a_url'],
      ['http://myco.example.com/join#' + KEY, 'not_https'],
      ['https://myco.example.com/enroll#' + KEY, 'wrong_path'],
      ['https://myco.example.com/join', 'no_key'],
      ['https://myco.example.com/join#short', 'key_grammar'],
    ];
    for (const [value, error] of cases) expect({ value, parsed: parseJoinCode(value) }).toEqual({ value, parsed: { error } });
  });
});

describe('spending a join code', () => {
  it('exchanges a Project-bound code for a credential, and answers what it granted and bound', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });

    const result = await exchangeJoinCode({ serverUrl: 'https://s', key: issued.key }, { fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox', forProject: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ role: result.answer.role, projectId: result.answer.projectId }).toEqual({ role: 'member', projectId: 'proj_1' });
    expect(r.rows('member_credentials')).toBe(1);
  });

  it('reports the Deployment\'s own refusal rather than a failure to reach it', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member' });
    const code = { serverUrl: 'https://s', key: issued.key };

    const refused = await exchangeJoinCode(code, { fetch: r.fetch as typeof fetch, machineId: 'machine_np', forProject: true });
    expect(refused).toMatchObject({ ok: false, code: 'enrollment_no_project' });
    expect(r.rows('member_credentials')).toBe(0);
  });

  it('reports an unreachable Deployment as unreachable, spending nothing', async () => {
    const dead = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const result = await exchangeJoinCode({ serverUrl: 'https://s', key: KEY }, { fetch: dead as unknown as typeof fetch, machineId: 'm' });
    expect(result).toMatchObject({ ok: false, code: 'unreachable' });
  });
});

describe('a sandbox holding only a join code', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-join-'));
    env = {};
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('joins on its first hook and records a credential the next hook reads, with no configuration of any kind', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-root-'));

    expect(readDeploymentMembership('https://s', home)).toBe(null);
    await ensureJoinedFromCode({ env, mycoHome: home, root, fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox' });

    const membership = readDeploymentMembership('https://s', home);
    expect(membership?.serverUrl).toBe('https://s');
    expect(membership?.token).toBeTruthy();
    // The Project the code named is bound to the root, so a hook resolves a full credential.
    expect(readRegistryEntry(root, home)?.projectId).toBe('proj_1');

    // A second hook spends nothing: one credential on the Deployment, whatever the hook count.
    await ensureJoinedFromCode({ env, mycoHome: home, root, fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox' });
    expect(r.rows('member_credentials')).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lets BOTH of two hooks starting together capture, on the one credential the single-use code yields', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-root-'));

    const both = [0, 1].map(() => ensureJoinedFromCode({ env, mycoHome: home, root, fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox' }));
    await Promise.all(both);

    // One exchange, one credential — and a membership every hook can read.
    expect(r.rows('member_credentials')).toBe(1);
    expect(readDeploymentMembership('https://s', home)?.token).toBeTruthy();
    expect(readRegistryEntry(root, home)?.projectId).toBe('proj_1');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the binding under the root a hook resolves, so the very next resolve finds a credential', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
    env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-root-'));

    await ensureJoinedFromCode({ env, mycoHome: home, root, fetch: r.fetch as typeof fetch, machineId: 'machine_sandbox' });

    // What `resolveCredential` needs: an entry keyed on that root, naming a Project and carrying a token.
    const entry = readRegistryEntry(root, home);
    expect({ projectId: entry?.projectId, hasToken: Boolean(entry?.token), root: entry?.root }).toEqual({ projectId: 'proj_1', hasToken: true, root });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does nothing at all when no join code is set, which is every run outside a sandbox', async () => {
    const r = unjoinedRig();
    await ensureJoinedFromCode({ env, mycoHome: home, fetch: r.fetch as typeof fetch });
    expect(readDeploymentMembership('https://s', home)).toBe(null);
    expect(r.rows('member_credentials')).toBe(0);
  });

  it('writes nothing when the Deployment refuses the code, leaving the machine as it found it', async () => {
    const r = unjoinedRig();
    const issued = await issueEnrollmentAuthority(r.env.db, Date.now(), { role: 'member' });
    env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;

    await ensureJoinedFromCode({ env, mycoHome: home, fetch: r.fetch as typeof fetch, machineId: 'machine_np' });
    expect(readDeploymentMembership('https://s', home)).toBe(null);
    expect(r.rows('member_credentials')).toBe(0);
  });

  it('writes nothing for a malformed code, and never reaches the Deployment with one', async () => {
    const r = unjoinedRig();
    let calls = 0;
    const counting = ((input: string | URL | Request, init?: RequestInit) => { calls += 1; return r.fetch(input, init); }) as typeof fetch;
    env[ENV_JOIN_CODE] = 'https://s/join#short';

    await ensureJoinedFromCode({ env, mycoHome: home, fetch: counting });
    expect({ calls, membership: readDeploymentMembership('https://s', home) }).toEqual({ calls: 0, membership: null });
  });
});
