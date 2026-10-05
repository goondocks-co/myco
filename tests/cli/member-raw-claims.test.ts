import { REJOIN_HINT } from '@goondocks/myco-shared/member-protocol';
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RawClaimPreview } from '@goondocks/myco-shared/raw-claims';
import { runRawClaims } from '@myco/cli/member-raw-claims.js';
import { runOwnership } from '@myco/cli/member-ownership.js';
import { runRole } from '@myco/cli/member-role.js';
import { MEMBER_HELP, run as runMember } from '@myco/cli/member.js';
import type { MemberVerbDeps } from '@myco/cli/deployment-reader.js';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { deploymentPath, REGISTRY_VERSION, writeDeploymentMembership } from '@myco/member/registry.js';

const TOKEN = 'a'.repeat(43);
const PREVIEW: RawClaimPreview = { revision: 'raw-r1', complete: true, projects: [{ projectId: 'proj_old', name: 'Archive', kinds: [{ kind: 'transcript', count: 2, oldestAt: 1_790_000_000_000, newestAt: 1_790_000_100_000 }] }] };
const savedExit = process.exitCode;
afterEach(() => { process.exitCode = savedExit; });

function fixture(overrides: { preview?: RawClaimPreview; status?: number; code?: string } = {}) {
  const requests: Array<{ method: string; path: string; body: unknown; project: string | null }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: MemberVerbDeps = {
    env: { MYCO_SERVER_URL: 'https://raw-claims.invalid', MYCO_MEMBER_TOKEN: TOKEN },
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname, body: request.method === 'POST' ? await request.json() : null, project: request.headers.get('x-myco-project') });
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(init?.redirect).toBe('error');
      if (overrides.status !== undefined) return Response.json({ code: overrides.code, reason: 'refused' }, { status: overrides.status });
      if (url.pathname === '/members/ownership') return Response.json({ ownerMemberId: request.method === 'POST' ? 'mem_selected' : null, revision: 'ownership-r1', candidates: [{ memberId: 'mem_selected', label: 'Selected', role: 'admin', roleRevision: 'role-r1' }], proposalMemberId: 'mem_selected' });
      if (url.pathname === '/members/ownership/transfer') return Response.json({ ownerMemberId: 'mem_selected', revision: 'ownership-r2', candidates: [], proposalMemberId: null });
      if (url.pathname === '/members/roles') return Response.json(request.method === 'GET' ? { members: [{ id: 'mem_selected', label: 'Selected', role: 'member', roleRevision: 'role-r1' }] } : { memberId: 'mem_selected', role: 'admin', roleRevision: 'role-r2' });
      return Response.json(request.method === 'GET' ? overrides.preview ?? PREVIEW : { claimId: 'claim_one', preview: { ...PREVIEW, revision: 'raw-r2', projects: [] } });
    },
  };
  return { deps, requests, stdout, stderr };
}

describe('member raw-claims CLI', () => {
  it('defaults to a Deployment-scoped preview carrying project, kind, counts, date and revision', async () => {
    const f = fixture();
    expect(await runRawClaims(['--credential', 'env'], f.deps)).toBe(true);
    expect(f.requests).toEqual([{ method: 'GET', path: '/members/raw-claims', body: null, project: null }]);
    expect(JSON.parse(f.stdout[0]!)).toEqual(PREVIEW);
    expect(f.stdout.join('\n')).not.toContain(TOKEN);
    expect(f.stderr).toEqual([]);
  });

  it('only writes the explicitly reviewed complete revision through the real member dispatcher', async () => {
    const f = fixture();
    await runMember(['raw-claims', '--credential', 'env', '--apply', '--revision', 'raw-r1'], f.deps);
    expect(f.requests.map((r) => [r.method, r.path, r.body, r.project])).toEqual([
      ['GET', '/members/raw-claims', null, null], ['POST', '/members/raw-claims', { revision: 'raw-r1' }, null],
    ]);
    expect(JSON.parse(f.stdout[1]!).claimId).toBe('claim_one');
    expect(MEMBER_HELP).toContain('raw-claims');
  });

  it.each([['--apply'], ['--revision', 'raw-r1'], ['--apply', '--revision'], ['--apply', '--revision', '--token'], ['--token', TOKEN]])('refuses unreviewed or credential-bearing arguments %j without dialing', async (...args) => {
    const f = fixture();
    expect(await runRawClaims(['--credential', 'env', ...args], f.deps)).toBe(false);
    expect(f.requests).toHaveLength(0);
    expect(f.stderr.join('\n')).not.toContain(TOKEN);
  });

  it.each([
    { preview: { ...PREVIEW, complete: false }, revision: 'raw-r1', reason: 'still running' },
    { preview: PREVIEW, revision: 'stale', reason: 'raw data changed' },
  ])('never applies an incomplete or stale preview', async ({ preview, revision, reason }) => {
    const f = fixture({ preview });
    expect(await runRawClaims(['--credential', 'env', '--apply', '--revision', revision], f.deps)).toBe(false);
    expect(f.requests.map((r) => r.method)).toEqual(['GET']);
    expect(f.stderr.join('\n')).toContain(reason);
  });

  it.each([{ status: 403, code: 'not_owner' }, { status: 409, code: 'backfill_pending' }, { status: 409, code: 'revision_conflict' }, { status: 401, code: 'unauthorized' }, { status: 200, code: 'not_owner' }])('surfaces %s without retry or claim', async ({ status, code }) => {
    const f = fixture({ status, code });
    expect(await runRawClaims(['--credential', 'env'], f.deps)).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(f.stderr).toHaveLength(1);
    expect(f.stderr.join('\n')).not.toContain(TOKEN);
    expect(f.stdout).toEqual([]);
    if (code === 'not_owner') expect(f.stderr.join('\n')).toContain('only the recorded Deployment owner');
    if (code === 'unauthorized') expect(f.stderr.join('\n')).toContain(REJOIN_HINT);
  });

  it('refuses persisted:false on HTTP 200 before showing an apparently valid preview', async () => {
    const f = fixture();
    f.deps.fetch = async () => Response.json({ persisted: false, ...PREVIEW });
    expect(await runRawClaims(['--credential', 'env'], f.deps)).toBe(false);
    expect(f.stdout).toEqual([]);
    expect(f.stderr.join('\n')).toContain('refused or failed the preview');
  });
});

describe('explicit ownership CLI', () => {
  it('previews by default and records only the supplied person with its reviewed revision', async () => {
    const f = fixture();
    expect(await runOwnership(['--credential', 'env'], f.deps)).toBe(true);
    expect(f.requests.map((r) => r.method)).toEqual(['GET']);
    expect(JSON.parse(f.stdout[0]!)).toEqual({ ownerMemberId: null, revision: 'ownership-r1', candidates: [{ memberId: 'mem_selected', label: 'Selected', role: 'admin', roleRevision: 'role-r1' }], proposalMemberId: 'mem_selected' });
    await runMember(['ownership', '--credential', 'env', '--owner', 'mem_selected', '--revision', 'ownership-r1'], f.deps);
    expect(f.requests.at(-1)).toEqual({ method: 'POST', path: '/members/ownership', body: { ownerMemberId: 'mem_selected', revision: 'ownership-r1' }, project: null });
  });

  it.each([['--owner', 'mem_selected'], ['--revision', 'ownership-r1']])('requires both explicit owner and revision', async (...args) => {
    const f = fixture();
    expect(await runOwnership(['--credential', 'env', ...args], f.deps)).toBe(false);
    expect(f.requests).toHaveLength(0);
  });

  it('refuses a stale ownership revision before writing', async () => {
    const f = fixture();
    expect(await runOwnership(['--credential', 'env', '--owner', 'mem_selected', '--revision', 'stale'], f.deps)).toBe(false);
    expect(f.requests.map((r) => r.method)).toEqual(['GET']);
    expect(f.stderr.join('\n')).toContain('ownership changed');
  });

  it('transfers only to a candidate from a reviewed current owner preview', async () => {
    const f = fixture();
    f.deps.fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      f.requests.push({ method: request.method, path, body: request.method === 'POST' ? await request.json() : null, project: request.headers.get('x-myco-project') });
      return Response.json(request.method === 'GET'
        ? { ownerMemberId: 'mem_old', revision: 'ownership-r1', candidates: [{ memberId: 'mem_selected', label: 'Selected', role: 'admin', roleRevision: 'role-r1' }], proposalMemberId: null }
        : { ownerMemberId: 'mem_selected', revision: 'ownership-r2', candidates: [], proposalMemberId: null });
    };
    expect(await runOwnership(['--credential', 'env', '--transfer', 'mem_selected', '--revision', 'ownership-r1'], f.deps)).toBe(true);
    expect(f.requests.at(-1)).toEqual({ method: 'POST', path: '/members/ownership/transfer', body: { member_id: 'mem_selected', expected_revision: 'ownership-r1' }, project: null });
  });
});

describe('member role CLI', () => {
  it('previews role revisions and applies only the reviewed member revision', async () => {
    const f = fixture();
    expect(await runRole(['--credential', 'env'], f.deps)).toBe(true);
    expect(f.requests).toEqual([{ method: 'GET', path: '/members/roles', body: null, project: null }]);
    await runMember(['role', '--credential', 'env', '--member', 'mem_selected', '--role', 'admin', '--revision', 'role-r1'], f.deps);
    expect(f.requests.at(-1)).toEqual({ method: 'POST', path: '/members/roles', body: { member_id: 'mem_selected', role: 'admin', expected_revision: 'role-r1' }, project: null });
  });

  it('refuses a stale revision and incomplete role arguments before writing', async () => {
    const f = fixture();
    expect(await runRole(['--credential', 'env', '--member', 'mem_selected', '--role', 'admin', '--revision', 'stale'], f.deps)).toBe(false);
    expect(f.requests.map((r) => r.method)).toEqual(['GET']);
    expect(await runRole(['--credential', 'env', '--member', 'mem_selected'], f.deps)).toBe(false);
    expect(f.requests).toHaveLength(1);
  });
});

describe('Deployment credential selection', () => {
  it('renews a refused registry credential once through the membership writer without requiring a Project', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-raw-claim-renewal-'));
    const serverUrl = 'https://raw-claims.invalid';
    const successor = 'b'.repeat(43);
    const now = Date.now();
    const requests: Array<{ path: string; token: string | null; project: string | null }> = [];
    try {
      writeDeploymentMembership({ version: REGISTRY_VERSION, serverUrl, token: TOKEN, machineId: 'machine_owner', joinedAt: now, updatedAt: now, expiresAt: now + 604_800_000 }, { mycoHome: home });
      recordDefaultDeployment(serverUrl, { mycoHome: home });
      const deps: MemberVerbDeps = { cwd: home, mycoHome: home, env: {}, stdout: () => undefined, stderr: () => undefined, fetch: async (input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        const token = request.headers.get('authorization');
        requests.push({ path: pathname, token, project: request.headers.get('x-myco-project') });
        if (pathname === '/tokens/refresh') return Response.json({ refreshed: true, token: successor, tokenId: 'mt_successor', expiresAt: now + 604_800_000, refreshAfter: now + 400_000_000 });
        return token === `Bearer ${TOKEN}` ? new Response(null, { status: 401 }) : Response.json(PREVIEW);
      } };
      expect(await runRawClaims([], deps)).toBe(true);
      expect(requests).toEqual([
        { path: '/members/raw-claims', token: `Bearer ${TOKEN}`, project: null },
        { path: '/tokens/refresh', token: `Bearer ${TOKEN}`, project: null },
        { path: '/members/raw-claims', token: `Bearer ${successor}`, project: null },
      ]);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  it('uses the recorded default or explicit server with no bound Project and never chooses by cwd', async () => {
    const f = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-raw-claim-registry-'));
    const serverUrl = 'https://raw-claims.invalid';
    try {
      writeDeploymentMembership({ version: REGISTRY_VERSION, serverUrl, token: TOKEN, machineId: 'machine_owner', joinedAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 604_800_000 }, { mycoHome: home });
      const deps = { ...f.deps, mycoHome: home, cwd: home, env: {} };
      expect(await runRawClaims([], deps)).toBe(false);
      expect(f.requests).toHaveLength(0);
      expect(await runRawClaims(['--server', serverUrl], deps)).toBe(true);
      expect(f.requests).toHaveLength(1);
      recordDefaultDeployment(serverUrl, { mycoHome: home });
      expect(await runOwnership([], deps)).toBe(true);
      expect(f.requests.at(-1)?.path).toBe('/members/ownership');
      expect(f.requests.every((request) => request.project === null)).toBe(true);
      fs.writeFileSync(deploymentPath(serverUrl, home), 'broken');
      expect(await runRawClaims([], deps)).toBe(false);
      expect(f.requests).toHaveLength(2);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses an explicit server different from the env credential without sending its bearer', async () => {
    const f = fixture();
    expect(await runRawClaims(['--credential', 'env', '--server', 'https://other.invalid'], f.deps)).toBe(false);
    expect(f.requests).toHaveLength(0);
    expect(f.stderr.join('\n')).not.toContain(TOKEN);
  });
});

it('runs the actual CLI on loopback with a bearer held only in its isolated environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-raw-claim-cli-'));
  const requests: Array<{ method: string; path: string; body: unknown; project: string | null }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const pathname = new URL(request.url).pathname;
    requests.push({ method: request.method, path: pathname, body: request.method === 'POST' ? await request.json() : null, project: request.headers.get('x-myco-project') });
    if (pathname === '/members/ownership') return Response.json({ ownerMemberId: request.method === 'POST' ? 'mem_selected' : null, revision: 'owner-r1', candidates: [{ memberId: 'mem_selected', label: 'Selected', role: 'admin', roleRevision: 'role-r1' }], proposalMemberId: 'mem_selected' });
    return Response.json(request.method === 'GET' ? PREVIEW : { claimId: 'claim_real_cli', preview: { ...PREVIEW, projects: [] } });
  } });
  try {
    const cli = path.resolve('packages/myco/src/cli.ts');
    const userHome = path.join(root, 'home');
    fs.mkdirSync(userHome);
    const env = { ...process.env, HOME: userHome, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), MYCO_HOME: path.join(root, 'myco'), MYCO_SERVER_URL: `http://127.0.0.1:${server.port}`, MYCO_MEMBER_TOKEN: TOKEN };
    delete (env as NodeJS.ProcessEnv).MYCO_PROJECT;
    const invoke = (op: 'raw-claims' | 'ownership', args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'member', op, '--credential', 'env', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (status) => resolve({ status, stdout, stderr }));
    });
    const preview = await invoke('raw-claims', []);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual(PREVIEW);
    const applied = await invoke('raw-claims', ['--apply', '--revision', PREVIEW.revision]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('claim_real_cli');
    expect(`${preview.stdout}${preview.stderr}${applied.stdout}${applied.stderr}`).not.toContain(TOKEN);
    const ownership = await invoke('ownership', []);
    expect(ownership.status).toBe(0);
    expect(JSON.parse(ownership.stdout)).toEqual({ ownerMemberId: null, revision: 'owner-r1', candidates: [{ memberId: 'mem_selected', label: 'Selected', role: 'admin', roleRevision: 'role-r1' }], proposalMemberId: 'mem_selected' });
    const recorded = await invoke('ownership', ['--owner', 'mem_selected', '--revision', 'owner-r1']);
    expect(recorded.status).toBe(0);
    expect(recorded.stdout).toContain('mem_selected');
    expect(`${ownership.stdout}${ownership.stderr}${recorded.stdout}${recorded.stderr}`).not.toContain(TOKEN);
    expect(requests).toEqual([
      { method: 'GET', path: '/members/raw-claims', body: null, project: null }, { method: 'GET', path: '/members/raw-claims', body: null, project: null }, { method: 'POST', path: '/members/raw-claims', body: { revision: PREVIEW.revision }, project: null },
      { method: 'GET', path: '/members/ownership', body: null, project: null }, { method: 'GET', path: '/members/ownership', body: null, project: null }, { method: 'POST', path: '/members/ownership', body: { ownerMemberId: 'mem_selected', revision: 'owner-r1' }, project: null },
    ]);
  } finally {
    server.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
