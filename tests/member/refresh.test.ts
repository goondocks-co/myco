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
import { MEMBER_TOKEN_REFRESH_WINDOW_MS } from '@myco/member/constants.js';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL, resolveMemberProjectRoot } from '@myco/member/credential.js';
import { refreshDue, refreshMemberCredential, refreshableRoot } from '@myco/member/refresh.js';
import { readRegistryEntry, writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
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

const prompt = (fetchImpl: FetchLike, text: string) =>
  runHook('user-prompt-submit', { session_id: session, hook_event_name: 'UserPromptSubmit', transcript_path: transcriptFile(), prompt: text }, { fetch: fetchImpl });

const budget = () => ({ connectTimeoutMs: 2_000, requestTimeoutMs: 10_000 });

describe('member token rotation', () => {
  it('a hook inside the window writes the successor; the next hook uses it and the predecessor is revoked at that first use', async () => {
    const rig = await nearExpiryRig();
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
    const spy = recordingFetch(rig.fetch);

    await prompt(spy.fetch, 'first');
    expect(refreshCalls(spy)).toBe(1);
    const successor = readRegistryEntry(root, mycoHome)!;
    expect(successor.token).not.toBe(rig.token);
    expect(successor.tokenId).not.toBe(rig.tokenId);
    expect(successor.expiresAt).toBeGreaterThan(rig.expiresAt);
    expect(successor.refreshAfter).toBe(successor.expiresAt! - MEMBER_TOKEN_REFRESH_WINDOW_MS);
    expect(tokenRow(rig, successor.tokenId!)).toEqual({ predecessor_id: rig.tokenId, lineage_root: rig.tokenId, first_used_at: null, revoked_at: null });
    expect(tokenRow(rig, rig.tokenId).revoked_at).toBeNull();
    expect(rig.rows('prompt_batches')).toBe(1);

    await prompt(spy.fetch, 'second');
    expect(rig.rows('prompt_batches')).toBe(2);
    expect(tokenRow(rig, successor.tokenId!).first_used_at).not.toBeNull();
    expect(tokenRow(rig, rig.tokenId).revoked_at).not.toBeNull();
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

    const out = await runHook('user-prompt-submit', { session_id: session, hook_event_name: 'UserPromptSubmit', transcript_path: transcriptFile(), prompt: 'hello' }, { fetch: spy.fetch, credential: 'env' });

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

    // This hook resolved the predecessor; the successor lands in the registry while its first send is in flight.
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: PROJECT, expiresAt: rig.expiresAt, serverUrl: SERVER_URL });
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
    expect(out.stderr).not.toContain('re-provision');
    expect(refreshCalls(spy)).toBe(0);
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

  it('a terminal refusal stops every further dial until the entry is re-provisioned', () => {
    const now = Date.now();
    const entry = { expiresAt: now + 1_000, refreshAfter: undefined, refreshTerminal: undefined };
    expect(refreshDue(entry, now)).toBe(true);
    expect(refreshDue({ ...entry, refreshTerminal: true }, now)).toBe(false);
    expect(refreshDue({ ...entry, expiresAt: now + 6 * DAY_MS }, now)).toBe(false);
    expect(refreshDue({ expiresAt: undefined, refreshAfter: undefined, refreshTerminal: undefined }, now)).toBe(true);
  });
});
