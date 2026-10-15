import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observeLegacyMigration } from '@myco/member/legacy-confirmation.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { readCutoverState, writeCutoverState } from '@myco/member/legacy-migration.js';
import { registryKeyFor, writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { legacyCaptureGuidance, legacyMovedNotice } from '@myco/cli/legacy-capture.js';
import { LEGACY_HISTORY_PATH, PROTOCOL_HEADER } from '@goondocks/myco-shared/member-protocol';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';

let root: string;
let restore: () => void;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-correction-'));
  restore = bindSandboxChildHome(root, { MYCO_HOME: path.join(root, 'myco') });
});
afterEach(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });

function fixture(projects: string[], options: { receipt?: boolean; complete?: boolean; sameName?: boolean; noMembers?: boolean; routes?: boolean } = {}) {
  const home = path.join(root, 'myco');
  const vault = path.join(home, 'groves', 'retained', 'myco.db');
  fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
  for (const id of projects) db.run("INSERT INTO sessions (id, project_id, project_root, agent, started_at, ended_at, status, title, created_at) VALUES (?, ?, ?, 'claude-code', 1700000000, 1700000060, 'completed', 'Retained title', 1700000000)",
    [`source-${id}`, id, path.join(root, id, options.sameName ? 'same-name' : id)]);
  db.close();
  if (options.receipt !== false) {
    const stamp = fs.statSync(vault);
    writeCutoverState(home, { backups: {}, migrations: { [vault]: { ...readVaultContent(vault), size: stamp.size, mtimeMs: stamp.mtimeMs,
      projects: Object.fromEntries(projects.map(id => [id, options.complete ? { vault: { state: 'complete', at: 1 } } : {}])) } } });
  }
  const member = (name: string) => ({ serverUrl: `https://${name}.invalid`, token: 'F'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 });
  if (!options.noMembers) for (const name of ['b', 'a']) writeDeploymentMembership(member(name), { mycoHome: home });
  if (options.routes) for (const name of ['a', 'b']) writeRegistryEntry({ ...member(name), version: 2, root: path.join(root, name), projectId: projects[0]! }, { mycoHome: home });
  if (options.noMembers && options.routes) {
    for (const name of ['a', 'b']) {
      const route = { ...member(name), version: 1, root: path.join(root, name), projectId: projects[0]! };
      fs.writeFileSync(path.join(home, 'member', 'projects', registryKeyFor(route.root) + '.json'), JSON.stringify(route), { mode: 0o600 });
    }
    for (const file of fs.readdirSync(path.join(home, 'member', 'deployments'))) fs.unlinkSync(path.join(home, 'member', 'deployments', file));
  }
  return { home, vault, bytes: fs.readFileSync(vault) };
}

function evidence(body: { eventGroups: string[][]; recordIds?: string[] }, last = false) {
  return Response.json({ persisted: true, confirmed: true, projectState: 'archived', eventIds: body.eventGroups.map(group => last ? group.at(-1) : group[0]), recordIds: body.recordIds ?? [], sporeIds: [], lineageIds: [] });
}

it('does not probe or describe earlier moves for never-moved route-free projects', async () => {
  const f = fixture(['proj_a', 'proj_b'], { receipt: false });
  let calls = 0;
  const observed = await observeLegacyMigration(f.home, { fetch: async () => { calls++; return Response.json({ persisted: false, code: 'no_project' }); } });
  expect(observed).toMatchObject({ state: 'unmoved', confirmation: 'not-found' });
  expect(calls).toBe(0);
  expect(JSON.stringify(legacyCaptureGuidance(observed))).not.toContain('earlier move');
  expect(readCutoverState(f.home).migrations).toBeUndefined();
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

it('uses destination wording when an unreceipted routed project needs sign-in', async () => {
  const f = fixture(['proj_a'], { receipt: false, noMembers: true, routes: true });
  writeCutoverState(f.home, { backups: { [f.vault]: { copy: 'unused', ...readVaultContent(f.vault), at: 1 } } });
  const observed = await observeLegacyMigration(f.home, { fetch: async () => { throw new Error('unexpected network'); } });
  expect(observed).toMatchObject({ state: 'needs-destination', confirmation: 'sign-in-required' });
  expect(legacyCaptureGuidance(observed).hint).toBe('Some Myco 1.4 projects need a destination; run myco setup --cutover to preview the handover.');
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

for (const ambiguous of ['proj_a', 'proj_z']) it(`retains ambiguous over missing regardless of project order: ${ambiguous}`, async () => {
  const f = fixture([ambiguous, 'proj_b']);
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/members/status') return Response.json({ persisted: true, deploymentId: new URL(request.url).hostname });
    if (request.headers.get('x-myco-project') !== ambiguous) return Response.json({ persisted: false, code: 'no_project' });
    return evidence(JSON.parse(String(init?.body)));
  } });
  expect(observed.confirmation).toBe('ambiguous');
  expect(legacyCaptureGuidance(observed).hint).toContain(ambiguous);
  expect(readCutoverState(f.home).migrations![f.vault]!.projects).toEqual({ [ambiguous]: {}, proj_b: {} });
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

for (const routed of [false, true]) it(`counts one Deployment under two addresses once, using its stable identity: routes=${routed}`, async () => {
  const f = fixture(['proj_alias'], { routes: routed });
  let identityCalls = 0;
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/members/status') {
      identityCalls++;
      expect(request.headers.has('x-myco-project')).toBe(false);
      return Response.json({ persisted: true, deploymentId: 'one-deployment' });
    }
    expect(new URL(request.url).pathname).toBe(LEGACY_HISTORY_PATH);
    return evidence(JSON.parse(String(init?.body)), new URL(request.url).hostname === 'b.invalid');
  } });
  expect(observed.state).toBe('moved');
  expect(identityCalls).toBe(2);
  expect(readCutoverState(f.home).migrations![f.vault]!.projects.proj_alias).toMatchObject({ destination: { serverUrl: 'https://a.invalid' }, root: routed ? path.join(root, 'a') : null });
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

it('skips an unauthorized membership for the remaining projects in one observation', async () => {
  const projects = Array.from({ length: 5 }, (_, i) => `proj_${i}`);
  const f = fixture(projects);
  const calls: string[] = [];
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(url.hostname + url.pathname);
    if (url.hostname === 'b.invalid') return new Response(null, { status: 401 });
    if (url.pathname === '/members/status') return Response.json({ persisted: true, deploymentId: 'deployment-a' });
    return evidence(JSON.parse(String(init?.body)));
  } });
  expect(observed.state).toBe('moved');
  expect(calls.filter(call => call.startsWith('b.invalid'))).toHaveLength(1);
  expect(calls.filter(call => call === 'a.invalid/members/status')).toHaveLength(1);
  expect(calls).toHaveLength(projects.length * 2 + 2);
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

for (const unauthorized of ['a.invalid', 'b.invalid']) it(`reports membership failures by fixed priority: unauthorized=${unauthorized}`, async () => {
  const f = fixture(['proj_failure']);
  const observed = await observeLegacyMigration(f.home, { fetch: async input => {
    if (new URL(new Request(input).url).hostname === unauthorized) return new Response(null, { status: 401 });
    throw new Error('offline');
  } });
  expect(observed.confirmation).toBe('sign-in-required');
  expect(readCutoverState(f.home).migrations![f.vault]!.projects.proj_failure).toEqual({});
});

it('requires full proof for a vault-complete receipt with no destination', async () => {
  const f = fixture(['proj_shortcut'], { complete: true });
  let proofs = 0;
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/members/status') return Response.json({ persisted: true, deploymentId: 'one-deployment' });
    const body = JSON.parse(String(init?.body));
    if (body.eventGroups.length === 0) return evidence(body);
    proofs++;
    return Response.json({ persisted: false, code: 'parse' });
  } });
  expect(proofs).toBeGreaterThan(0);
  expect(observed.confirmation).toBe('update-required');
  expect(readCutoverState(f.home).migrations![f.vault]!.projects.proj_shortcut).toEqual({ vault: { state: 'complete', at: 1 } });
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

it('names every missing project and disambiguates shared repository basenames', async () => {
  const f = fixture(['proj_a', 'proj_b'], { sameName: true });
  const observed = await observeLegacyMigration(f.home, { fetch: async () => Response.json({ persisted: false, code: 'no_project' }) });
  expect(observed.confirmation).toBe('no-destination');
  const hint = legacyCaptureGuidance(observed).hint;
  expect(hint).toContain('same-name (proj_a)');
  expect(hint).toContain('same-name (proj_b)');
  expect(hint).toContain('Keep the 1.4 data.');
});

it('uses one named terminal sentence per project, with basename collisions disambiguated', async () => {
  const f = fixture(['proj_a', 'proj_b'], { sameName: true });
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.hostname === 'b.invalid') return Response.json({ persisted: false, code: 'no_project' });
    if (url.pathname === '/members/status') return Response.json({ persisted: true, deploymentId: 'deployment-a' });
    return evidence(JSON.parse(String(init?.body)));
  } });
  expect(observed.terminalProjects).toEqual([{ name: 'same-name (proj_a)', state: 'archived' }, { name: 'same-name (proj_b)', state: 'archived' }]);
  expect(observed.terminalProjects!.map(p => legacyMovedNotice(p.name, p.state))).toEqual([
    'same-name (proj_a) has been moved; its project is archived on the Deployment.',
    'same-name (proj_b) has been moved; its project is archived on the Deployment.',
  ]);
});

it('reports sign-in-required when several routes name Deployments with no memberships', async () => {
  const f = fixture(['proj_routes'], { noMembers: true, routes: true });
  let calls = 0;
  const observed = await observeLegacyMigration(f.home, { fetch: async () => { calls++; throw new Error('must not dial'); } });
  expect(observed.confirmation).toBe('sign-in-required');
  expect(calls).toBe(0);
  expect(readCutoverState(f.home).migrations![f.vault]!.projects.proj_routes).toEqual({});
});

it('fails closed when a confirming fallback address cannot supply a stable Deployment identity', async () => {
  const f = fixture(['proj_old']);
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === '/members/status') return Response.json({ persisted: true });
    return evidence(JSON.parse(String(init?.body)));
  } });
  expect(observed.confirmation).toBe('update-required');
  expect(readCutoverState(f.home).migrations![f.vault]!.projects.proj_old).toEqual({});
});

it('keeps never-moved multi-route projects at not-found when no Deployment holds them', async () => {
  const f = fixture(['proj_unmoved'], { receipt: false, routes: true });
  const observed = await observeLegacyMigration(f.home, { fetch: async () => Response.json({ persisted: false, code: 'no_project' }) });
  expect(observed).toMatchObject({ state: 'unmoved', confirmation: 'not-found' });
  expect(legacyCaptureGuidance(observed).hint).toBeNull();
  expect(readCutoverState(f.home).migrations).toBeUndefined();
});

function routedProject(home: string, projectId: string, address: string) {
  writeRegistryEntry({ version: 2, root: path.join(root, projectId + '-' + address), projectId,
    serverUrl: 'https://' + address + '.invalid', token: 'F'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home });
}

it('B1: a deleted sibling does not block a routed held project', async () => {
  const f = fixture(['proj_a', 'proj_b']);
  for (const id of ['proj_a', 'proj_b']) routedProject(f.home, id, 'a');
  const asked: string[] = [];
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).pathname).toBe(LEGACY_HISTORY_PATH);
    const id = request.headers.get('x-myco-project')!;
    asked.push(id);
    return id === 'proj_a' ? Response.json({ persisted: false, code: 'no_project' }) : evidence(JSON.parse(String(init?.body)));
  } });
  expect(asked).toContain('proj_b');
  expect(observed.confirmation).toBe('project-missing');
  const receipt = readCutoverState(f.home).migrations![f.vault]!.projects;
  expect(receipt.proj_a).toEqual({});
  expect(receipt.proj_b).toMatchObject({ destination: { serverUrl: 'https://a.invalid' }, vault: { state: 'complete' } });
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

it('B2: a fallback identity missing on an older Deployment does not block a route-bound sibling', async () => {
  const f = fixture(['proj_a', 'proj_b']);
  routedProject(f.home, 'proj_b', 'a');
  let routedReads = 0;
  let identityReads = 0;
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/members/status') { identityReads++; return Response.json({ persisted: true }); }
    if (url.hostname === 'b.invalid') return Response.json({ persisted: false, code: 'no_project' });
    if (request.headers.get('x-myco-project') === 'proj_b') routedReads++;
    return evidence(JSON.parse(String(init?.body)));
  } });
  expect(routedReads).toBe(1);
  expect(identityReads).toBe(1);
  expect(observed.confirmation).toBe('update-required');
  const receipt = readCutoverState(f.home).migrations![f.vault]!.projects;
  expect(receipt.proj_a).toEqual({});
  expect(receipt.proj_b).toMatchObject({ destination: { serverUrl: 'https://a.invalid' }, vault: { state: 'complete' } });
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

it('B3: a sibling project-missing refusal does not remove a competing confirmer', async () => {
  const f = fixture(['proj_a', 'proj_b']);
  routedProject(f.home, 'proj_a', 'b');
  let competingProofs = 0;
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/members/status') return Response.json({ persisted: true, deploymentId: url.hostname });
    if (request.headers.get('x-myco-project') === 'proj_a') return Response.json({ persisted: false, code: 'no_project' });
    const body = JSON.parse(String(init?.body));
    if (url.hostname === 'b.invalid' && body.eventGroups.length > 0) competingProofs++;
    return evidence(body);
  } });
  expect(competingProofs).toBe(1);
  expect(observed.confirmation).toBe('ambiguous');
  expect(readCutoverState(f.home).migrations![f.vault]!.projects).toEqual({ proj_a: {}, proj_b: {} });
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

for (const identity of ['missing', 'unreachable'] as const) it('A1: a proven confirmer with ' + identity + ' identity prevents a fallback write', async () => {
  const f = fixture(['proj_a']);
  const proven: string[] = [];
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/members/status') {
      if (url.hostname === 'a.invalid') return Response.json({ persisted: true, deploymentId: 'known-a' });
      if (identity === 'missing') return Response.json({ persisted: true });
      throw new Error('identity offline');
    }
    const body = JSON.parse(String(init?.body));
    if (body.eventGroups.length > 0) proven.push(url.hostname);
    return evidence(body);
  } });
  expect(proven.sort()).toEqual(['a.invalid', 'b.invalid']);
  expect(observed.confirmation).toBe(identity === 'missing' ? 'update-required' : 'pending');
  expect(readCutoverState(f.home).migrations![f.vault]!.projects.proj_a).toEqual({});
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

for (const firstFailure of ['refused', 'refused-route-missing', 'busy', 'not-found', 'pending'] as const) it('does not memoize a sibling proof outcome: ' + firstFailure, async () => {
  const f = fixture(['proj_a', 'proj_b']);
  for (const id of ['proj_a', 'proj_b']) routedProject(f.home, id, 'a');
  let heldReads = 0;
  await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get('x-myco-project') === 'proj_b') { heldReads++; return evidence(JSON.parse(String(init?.body))); }
    if (firstFailure === 'refused' || firstFailure === 'refused-route-missing') return Response.json({ persisted: false, code: firstFailure === 'refused' ? 'parse' : 'route_missing' });
    if (firstFailure === 'busy') return new Response(null, { status: 503 });
    if (firstFailure === 'not-found') return Response.json({ persisted: true, confirmed: false });
    return new Promise<Response>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('fixture timed out')), { once: true }));
  } });
  expect(heldReads).toBe(1);
  expect(readCutoverState(f.home).migrations![f.vault]!.projects.proj_b).toMatchObject({ destination: { serverUrl: 'https://a.invalid' }, vault: { state: 'complete' } });
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

for (const failure of ['transport', 'protocol', 'route-missing'] as const) it('memoizes a membership-wide history failure: ' + failure, async () => {
  const f = fixture(['proj_a', 'proj_b', 'proj_c']);
  let failedReads = 0;
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'b.invalid') {
      failedReads++;
      if (failure === 'transport') throw new Error('offline');
      return new Response(null, { status: failure === 'protocol' ? 409 : 401, headers: { [PROTOCOL_HEADER]: '2' } });
    }
    if (url.pathname === '/members/status') return Response.json({ persisted: true, deploymentId: 'known-a' });
    return evidence(JSON.parse(String(init?.body)));
  } });
  expect(failedReads).toBe(1);
  expect(observed.state).toBe('moved');
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});

it('C1: memoizes a hanging project-state probe across three route-free projects', async () => {
  const projects = ['proj_a', 'proj_b', 'proj_c'];
  const f = fixture(projects);
  let hungReads = 0;
  let missingReads = 0;
  const observed = await observeLegacyMigration(f.home, { fetch: async (input, init) => {
    const request = new Request(input, init);
    expect(JSON.parse(String(init?.body))).toEqual({ eventGroups: [], projectState: true });
    if (new URL(request.url).hostname === 'a.invalid') {
      missingReads++;
      return Response.json({ persisted: false, code: 'no_project' });
    }
    hungReads++;
    return new Promise<Response>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('fixture timed out')), { once: true }));
  } });
  expect(observed.confirmation).toBe('pending');
  expect(observed.confirmationProjects).toEqual(projects.map(name => ({ name, confirmation: 'pending', receipted: true })));
  expect(hungReads).toBe(1);
  expect(missingReads).toBe(3);
  expect(readCutoverState(f.home).migrations![f.vault]!.projects).toEqual(Object.fromEntries(projects.map(id => [id, {}])));
  expect(fs.readFileSync(f.vault)).toEqual(f.bytes);
});
