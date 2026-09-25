/**
 * Member token rotation through the in-process worker: a hook inside the
 * refresh window writes the successor and the next hook uses it (revoking the
 * predecessor at its first use); an env-sourced credential never rotates even
 * with a registry entry beside it; two concurrent refreshes produce one
 * successor and the loser keeps the predecessor; `refresh_too_early` is
 * obeyed until the announced instant; a 401 on a live send re-reads the
 * registry and retries once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { run as runMemberCli } from '@myco/cli/member.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { MEMBER_TOKEN_REFRESH_WINDOW_MS, PROJECT_HEADER, REFRESH_NO_PROJECT_BACKOFF_MS, TERMINAL_RETRY_INTERVAL_MS } from '@myco/member/constants.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL, resolveMemberProjectRoot } from '@myco/member/credential.js';
import { buildIdentity, refreshDue, refreshMemberCredential, refreshMembership, refreshableRoot } from '@myco/member/refresh.js';
import { readDeploymentMembership, readRegistryEntry, writeDeploymentMembership, writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient, type FetchLike } from '@myco/member/transport.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { recordingFetch, registerTestMember, runHook } from './helpers/hooks.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_URL = 'https://member-test.invalid';
const PROJECT = 'proj_1';

let mycoHome: string;
let root: string;
const savedHome = process.env.MYCO_HOME;
const savedEnv = { url: process.env[ENV_SERVER_URL], token: process.env[ENV_MEMBER_TOKEN], project: process.env[ENV_PROJECT] };

beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  root = resolveMemberProjectRoot(process.cwd());
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  for (const [name, value] of [[ENV_SERVER_URL, savedEnv.url], [ENV_MEMBER_TOKEN, savedEnv.token], [ENV_PROJECT, savedEnv.project]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetMachineIdCache();
});

/** A rig whose member token was issued 6.5 days ago: live, and inside its refresh window. */
const nearExpiryRig = (): Promise<MemberRig> => memberRig({ now: Date.now() - 6.5 * DAY_MS });

const tokenRow = (rig: MemberRig, id: string): Record<string, unknown> =>
  rig.env.sqlite.query('SELECT predecessor_id, lineage_root, first_used_at, revoked_at FROM member_credentials WHERE id = ?').get(id) as Record<string, unknown>;

const refreshCalls = (spy: ReturnType<typeof recordingFetch>): number => spy.requests.filter((r) => r.path === '/tokens/refresh').length;
const eventCalls = (spy: ReturnType<typeof recordingFetch>): number => spy.requests.filter((r) => r.path === '/events').length;

const session = 'sess-refresh-1';
const transcriptFile = (): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-tx-')), `${session}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: root, message: { role: 'user', content: 'hello' }, uuid: 'u1', timestamp: '2026-01-01T00:00:00Z' }) + '\n');
  return file;
};

/** Copilot's prompt hook ships the prompt row, so each prompt is a live send the rotation can ride. */
const prompt = (fetchImpl: FetchLike, text: string) =>
  runHook('user-prompt-submit', { session_id: session, hook_event_name: 'UserPromptSubmit', transcript_path: transcriptFile(), prompt: text }, { fetch: fetchImpl, symbiont: 'copilot' });

const budget = () => ({ connectTimeoutMs: 2_000, requestTimeoutMs: 10_000 });

describe('member token rotation', () => {
  it('a hook inside the window writes the successor before it delivers, and delivers on it: the predecessor is revoked at that first use', async () => {
    const rig = await nearExpiryRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spy = recordingFetch(rig.fetch);

    await prompt(spy.fetch, 'first');
    expect(refreshCalls(spy)).toBe(1);
    expect(spy.requests[0].path).toBe('/tokens/refresh');
    const successor = readRegistryEntry(root, mycoHome)!;
    expect(successor.token).not.toBe(rig.token);
    expect(successor.tokenId).not.toBe(rig.tokenId);
    expect(successor.expiresAt).toBeGreaterThan(rig.expiresAt);
    expect(successor.refreshAfter).toBe(successor.expiresAt! - MEMBER_TOKEN_REFRESH_WINDOW_MS);
    expect(tokenRow(rig, successor.tokenId!)).toMatchObject({ predecessor_id: rig.tokenId, lineage_root: rig.tokenId, revoked_at: null });
    expect(tokenRow(rig, successor.tokenId!).first_used_at).not.toBeNull();
    expect(tokenRow(rig, rig.tokenId).revoked_at).not.toBeNull();
    expect(rig.rows('prompt_batches')).toBe(1);

    await prompt(spy.fetch, 'second');
    expect(rig.rows('prompt_batches')).toBe(2);
    // The successor's own window is a full TTL away: the second hook does not dial the refresh route.
    expect(refreshCalls(spy)).toBe(1);
  });

  it('an env-sourced credential never rotates, even with a registry entry for the same root beside it', async () => {
    const rig = await nearExpiryRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    process.env[ENV_SERVER_URL] = SERVER_URL;
    process.env[ENV_MEMBER_TOKEN] = rig.token;
    process.env[ENV_PROJECT] = PROJECT;
    const spy = recordingFetch(rig.fetch);

    const out = await runHook('user-prompt-submit', { session_id: session, hook_event_name: 'UserPromptSubmit', transcript_path: transcriptFile(), prompt: 'hello' }, { fetch: spy.fetch, credential: 'env', symbiont: 'copilot' });

    expect(out.stderr).toBe('');
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(refreshCalls(spy)).toBe(0);
    expect(rig.rows('member_credentials')).toBe(1);
    expect(readRegistryEntry(root, mycoHome)!.token).toBe(rig.token);
    expect(refreshableRoot({ source: 'env', root })).toBeNull();
  });

  it('two concurrent refreshes write one successor; the loser continues on the predecessor', async () => {
    const rig = await nearExpiryRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spy = recordingFetch(rig.fetch);

    const [a, b] = await Promise.all([
      refreshMemberCredential(root, { mycoHome, fetch: spy.fetch, budget: budget() }),
      refreshMemberCredential(root, { mycoHome, fetch: spy.fetch, budget: budget() }),
    ]);

    expect([a.status, b.status].sort()).toEqual(['busy', 'refreshed']);
    expect(refreshCalls(spy)).toBe(1);
    expect(rig.rows('member_credentials')).toBe(2);
    const winner = a.status === 'refreshed' ? a : b;
    const loser = a.status === 'refreshed' ? b : a;
    expect(loser.entry!.token).toBe(rig.token);
    expect(tokenRow(rig, rig.tokenId).revoked_at).toBeNull();
    expect(readRegistryEntry(root, mycoHome)!.tokenId).toBe(winner.tokenId!);
  });

  it('`refresh_too_early` records the announced instant and nothing dials again until it passes', async () => {
    const rig = await memberRig();
    // The entry believes the window is open an hour from now; the server, which owns the window, does not.
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: Date.now() + 60 * 60 * 1000, serverUrl: SERVER_URL });
    const spy = recordingFetch(rig.fetch);

    const first = await refreshMemberCredential(root, { mycoHome, fetch: spy.fetch, budget: budget() });
    expect(first.status).toBe('too-early');
    const announced = first.entry!.refreshAfter!;
    expect(announced).toBe(rig.expiresAt - MEMBER_TOKEN_REFRESH_WINDOW_MS);
    expect(refreshCalls(spy)).toBe(1);

    expect((await refreshMemberCredential(root, { mycoHome, fetch: spy.fetch, budget: budget() })).status).toBe('not-due');
    expect(refreshCalls(spy)).toBe(1);

    await refreshMemberCredential(root, { mycoHome, fetch: spy.fetch, now: () => announced + 1, budget: budget() });
    expect(refreshCalls(spy)).toBe(2);
    expect(rig.rows('member_credentials')).toBe(1);
  });

  it('a 401 on a live send re-reads the registry and retries the record once with the rotated token', async () => {
    const rig = await nearExpiryRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    // Another hook rotated and used the successor: this hook's token is revoked before it sends.
    await refreshMemberCredential(root, { mycoHome, fetch: rig.fetch, budget: budget() });
    const successor = readRegistryEntry(root, mycoHome)!;
    expect((await new ServerClient(successor, rig.fetch).refresh(budget())).class).toBe('refused');
    expect(tokenRow(rig, rig.tokenId).revoked_at).not.toBeNull();

    // This hook resolved the predecessor, recorded with a window it does not see open; the successor lands in the registry while its first send is in flight.
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt + 7 * DAY_MS, serverUrl: SERVER_URL });
    let swapped = false;
    const swapping: FetchLike = async (input, init) => {
      const req = new Request(input, init);
      if (!swapped && new URL(req.url).pathname === '/events') {
        swapped = true;
        writeRegistryEntry({ ...successor, updatedAt: Date.now() } satisfies RegistryEntry, { mycoHome });
      }
      return rig.fetch(req);
    };
    const spy = recordingFetch(swapping);

    const out = await prompt(spy.fetch, 'after rotation');

    expect(eventCalls(spy)).toBe(2);
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(new MemberSpool(PROJECT, { mycoHome }).depth(session)).toBe(0);
    expect(out.stderr).not.toContain('myco login');
    expect(refreshCalls(spy)).toBe(0);
  });

  it('rotates a membership no project is bound to, as a worker-only machine holds, with a request that names no Project', async () => {
    const rig = await memberRig({ now: Date.now() - 20 * DAY_MS });
    writeDeploymentMembership({ serverUrl: SERVER_URL, token: rig.token, tokenId: rig.tokenId, expiresAt: rig.expiresAt, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
    const spy = recordingFetch(rig.fetch);

    const report = await refreshMembership(SERVER_URL, { mycoHome, fetch: spy.fetch, budget: budget() });

    expect(report.status).toBe('refreshed');
    expect(spy.requests.map((r) => ({ path: r.path, project: PROJECT_HEADER in r.headers }))).toEqual([{ path: '/tokens/refresh', project: false }]);
    const held = readDeploymentMembership(SERVER_URL, mycoHome)!;
    expect({ token: held.token === rig.token, tokenId: held.tokenId, terminal: held.refreshTerminal }).toEqual({ token: false, tokenId: report.tokenId, terminal: undefined });
    expect(tokenRow(rig, report.tokenId!)).toMatchObject({ predecessor_id: rig.tokenId, lineage_root: rig.tokenId });
    expect((await refreshMembership(SERVER_URL, { mycoHome, fetch: spy.fetch, budget: budget() })).status).toBe('not-due');
    expect((await refreshMembership('https://elsewhere.invalid', { mycoHome, fetch: spy.fetch, budget: budget() })).status).toBe('no-entry');
  });

  it('names the Project of a project root on its refresh, and reads a server refusing a refresh for want of a Project as a retry, never as final', async () => {
    const rig = await nearExpiryRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const seen: Array<string | null> = [];
    const olderServer: FetchLike = async (input, init) => {
      const req = new Request(input, init);
      seen.push(req.headers.get(PROJECT_HEADER));
      return Response.json({ refreshed: false, code: 'no_project', reason: 'no project' }, { headers: { 'x-myco-protocol': '1' } });
    };

    const report = await refreshMemberCredential(root, { mycoHome, fetch: olderServer, budget: budget() });

    expect(seen).toEqual([PROJECT]);
    expect(report.status).toBe('retry');
    const entry = readRegistryEntry(root, mycoHome)!;
    expect({ terminal: entry.refreshTerminal, token: entry.token }).toEqual({ terminal: undefined, token: rig.token });
    expect(refreshDue(entry, Date.now())).toBe(true);
  });

  it('asks about another build\'s terminal refusal once per build per day, recording the attempt whatever answers it, so two builds sharing a home never alternate', async () => {
    const now = Date.now();
    const terminal = { expiresAt: now - 1, refreshAfter: undefined, refreshTerminal: true, refreshTerminalBy: 'build-x' };
    expect(refreshDue({ ...terminal, refreshRetries: undefined }, now, 'build-a')).toBe(true);
    const tried = { ...terminal, refreshRetries: { 'build-a': now, 'build-b': now } };
    expect([refreshDue(tried, now + 1, 'build-a'), refreshDue(tried, now + 1, 'build-b')]).toEqual([false, false]);
    expect(refreshDue(tried, now + TERMINAL_RETRY_INTERVAL_MS, 'build-a')).toBe(true);
    expect(refreshDue({ ...tried, refreshTerminalBy: 'build-a' }, now + 10 * TERMINAL_RETRY_INTERVAL_MS, 'build-a')).toBe(false);

    // The attempt is recorded before the dial: an unreachable Deployment spends it as surely as an answer.
    writeDeploymentMembership({ serverUrl: SERVER_URL, token: 'x'.repeat(43), refreshTerminal: true, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
    let dials = 0;
    const unreachable: FetchLike = async () => { dials += 1; throw new TypeError('fetch failed'); };
    expect((await refreshMembership(SERVER_URL, { mycoHome, fetch: unreachable, budget: budget() })).status).toBe('retry');
    expect(readDeploymentMembership(SERVER_URL, mycoHome)!.refreshRetries?.[buildIdentity()]).toBeGreaterThan(0);
    expect((await refreshMembership(SERVER_URL, { mycoHome, fetch: unreachable, budget: budget() })).status).toBe('not-due');
    expect(dials).toBe(1);
  });

  it('waits before asking again when a server refuses a refresh naming no Project, for a membership no project is bound to', async () => {
    writeDeploymentMembership({ serverUrl: SERVER_URL, token: 'x'.repeat(43), expiresAt: Date.now() + DAY_MS, machineId: 'machine_1', joinedAt: 1, updatedAt: 1 }, { mycoHome });
    let dials = 0;
    const olderServer: FetchLike = async () => { dials += 1; return Response.json({ refreshed: false, code: 'no_project', reason: 'no project' }, { headers: { 'x-myco-protocol': '1' } }); };
    expect((await refreshMembership(SERVER_URL, { mycoHome, fetch: olderServer, budget: budget() })).status).toBe('retry');
    const held = readDeploymentMembership(SERVER_URL, mycoHome)!;
    expect({ terminal: held.refreshTerminal, waits: (held.refreshAfter ?? 0) - Date.now() > REFRESH_NO_PROJECT_BACKOFF_MS - 60_000 }).toEqual({ terminal: undefined, waits: true });
    expect((await refreshMembership(SERVER_URL, { mycoHome, fetch: olderServer, budget: budget() })).status).toBe('not-due');
    expect(dials).toBe(1);
  });

  it('`myco member refresh` rotates the entry and says what happened', async () => {
    const rig = await nearExpiryRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const out: string[] = [];
    const err: string[] = [];

    await runMemberCli(['refresh'], { mycoHome, fetch: rig.fetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });

    const successor = readRegistryEntry(root, mycoHome)!;
    expect(out.join('\n')).toContain(`proj_1: rotated to ${successor.tokenId}`);
    expect(out.join('\n')).not.toContain(successor.token);
    expect(err).toEqual([]);

    out.length = 0;
    await runMemberCli(['refresh'], { mycoHome, fetch: rig.fetch, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect(out.join('\n')).toContain('not due — refresh window opens');
    expect(rig.rows('member_credentials')).toBe(2);
  });

  it('a terminal refusal this build recorded stops every further dial until the entry is re-provisioned; one another build recorded is asked about once more', () => {
    const now = Date.now();
    const entry = { expiresAt: now + 1_000, refreshAfter: undefined, refreshTerminal: undefined, refreshTerminalBy: undefined };
    expect(refreshDue(entry, now)).toBe(true);
    expect(refreshDue({ ...entry, refreshTerminal: true, refreshTerminalBy: 'build-b' }, now, 'build-b')).toBe(false);
    expect(refreshDue({ ...entry, refreshTerminal: true, refreshTerminalBy: 'build-a' }, now, 'build-b')).toBe(true);
    expect(refreshDue({ ...entry, refreshTerminal: true }, now, 'build-b')).toBe(true);
    expect(refreshDue({ ...entry, expiresAt: now + 6 * DAY_MS }, now)).toBe(false);
    expect(refreshDue({ expiresAt: undefined, refreshAfter: undefined, refreshTerminal: undefined, refreshTerminalBy: undefined }, now)).toBe(true);
  });
});
