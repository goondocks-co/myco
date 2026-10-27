import { runCutover as executeCutoverPlan,planCutover } from '@myco/cli/cutover.js';
import { Database } from 'bun:sqlite';
import { afterEach,beforeEach,describe,expect,it,spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { legacyProjectImportComplete,runLegacyImport } from '@myco/member/legacy-import.js';
import { LegacyLedger } from '@myco/member/legacy-ledger.js';
import { legacyMigrationState,readCutoverState } from '@myco/member/legacy-migration.js';
import { legacyStrayHistoryLines,observeLegacyStrayHistory } from '@myco/member/legacy-strays.js';
import { deploymentKeyFor,logoutBindings,registryEntryPath,removeDeploymentForLogout,writeDeploymentMembership,writeRegistryEntry } from '@myco/member/registry.js';
import { routedSpoolDir } from '@myco/member/routing.js';
import { resolveMachineIdPath } from '@myco/paths/home.js';
import { resolvePackageRoot } from '@myco/symbionts/detect.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { memberRig,TEST_MACHINE_ID,type MemberRig } from '../member/helpers/server.js';

import { machine,NOW_S,PROJECT,readJson,SERVER,sha,writeJson,type Machine } from './cutover-machine.js';

describe('cutover project destinations and receipts', () => {
  let m: Machine;
  let personal: MemberRig;
  let homelab: string;
  let heldHome: string | undefined;
  const PERSONAL = 'https://personal.invalid';
  const HOMELAB = 'proj_homelab';
  beforeEach(async () => {
    m = await machine();
    heldHome = process.env.HOME; process.env.HOME = m.home;
    personal = await memberRig({ projectId: HOMELAB });
    homelab = path.join(m.home, 'Repos', 'homelab');
    fs.mkdirSync(homelab, { recursive: true }); execFileSync('git', ['init', '-q', homelab]);
    writeDeploymentMembership({ serverUrl: PERSONAL, token: personal.token, tokenId: personal.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome: m.mycoHome });
    writeRegistryEntry({ version: 2, root: homelab, projectId: HOMELAB, serverUrl: PERSONAL, token: personal.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    recordDefaultDeployment(SERVER, { mycoHome: m.mycoHome });
    const db = new Database(m.vault);
    try {
      db.run('PRAGMA foreign_keys=OFF');
      db.run("INSERT INTO sessions (id,agent,project_root,project_id,started_at,ended_at,status,title,created_at) VALUES ('00000000-0000-4000-8000-000000000002','claude-code',?,?,?,?,'completed','personal session',?)", [homelab, HOMELAB, NOW_S - 86400, NOW_S - 86000, NOW_S - 86400]);
      db.run("INSERT INTO spores (id,project_id,agent_id,observation_type,status,content,created_at) VALUES ('personal-spore',?,'user','gotcha','active','personal only',?)", [HOMELAB, NOW_S]);
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
  });
  afterEach(() => { if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome; });
  const fetchBoth: MemberRig['fetch'] = (input, init) => {
    const req = new Request(input, init);
    return new URL(req.url).origin === PERSONAL ? personal.fetch(req) : m.rig.fetch(req);
  };
  const projectsOn = (rig: MemberRig, table: string) => rig.env.sqlite.query(`SELECT DISTINCT project_id FROM ${table} ORDER BY project_id`).all();

  for (const copies of [1, 2]) it(`reports ${copies} earlier stray copies in preview and execution without touching them`, async () => {
    const imported = await runLegacyImport({ sources: [m.vault], project: HOMELAB, serverUrl: SERVER }, { mycoHome: m.mycoHome, machineId: TEST_MACHINE_ID, fetch: m.rig.fetch, sleep: async () => {} });
    expect(imported.projects.every(legacyProjectImportComplete)).toBe(true);
    expect(projectsOn(m.rig, 'spores')).toContainEqual({ project_id: HOMELAB });
    const urls = [SERVER, 'https://other-work.invalid'].slice(0, copies);
    const ledgers = urls.map(serverUrl => {
      writeDeploymentMembership({ serverUrl, token: m.rig.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
      const ledger = new LegacyLedger(m.mycoHome, serverUrl, HOMELAB);
      ledger.append({ k: 'spore', id: 'earlier-personal-spore' });
      return { file: ledger.file, bytes: fs.readFileSync(ledger.file) };
    });
    const data = m.rig.env.sqlite.serialize();
    const requests: string[] = [];
    const fetch: MemberRig['fetch'] = (input, init) => {
      const req = new Request(input, init);
      requests.push(new URL(req.url).origin);
      return fetchBoth(req);
    };
    for (const args of [['--dry-run'], []]) {
      const result = await m.run([...args, '--skip', PROJECT], { fetch, agents: [] });
      expect(result.err).toEqual([]); expect(result.ok).toBe(true);
      const lines = result.out.filter(line => line.includes('An earlier move also put'));
      expect(lines).toHaveLength(copies);
      for (const url of urls) expect(lines.some(line => line.includes(`homelab's history on ${url} (it now goes to ${PERSONAL})`))).toBe(true);
      for (const ledger of ledgers) expect(fs.readFileSync(ledger.file)).toEqual(ledger.bytes);
      expect(m.rig.env.sqlite.serialize()).toEqual(data);
    }
    expect(requests.every(url => url === PERSONAL)).toBe(true);
  });

  it('dismisses earlier copies locally and raises them again when accepted history grows', async () => {
    const ledger = new LegacyLedger(m.mycoHome, SERVER, HOMELAB);
    ledger.append({ k: 'session', session: 'accepted-session' });
    const file = path.join(m.mycoHome, 'member', 'cutover.json');
    writeJson(file, { backups: {}, migrations: { [m.vault]: { digest: 'earlier', size: 1, mtimeMs: 1, projects: {
      [HOMELAB]: { destinations: { [deploymentKeyFor(SERVER)]: { serverUrl: SERVER, digest: 'earlier', size: 1, mtimeMs: 1,
        evidence: { kind: 'deployment', at: 1, machineId: TEST_MACHINE_ID, eventIds: ['accepted-event'], sporeIds: ['accepted-spore'] },
      } } },
    } } } });
    fs.chmodSync(file, 0o600);
    const proof = fs.readFileSync(file);
    const bytes = fs.readFileSync(ledger.file);
    const fetch: MemberRig['fetch'] = () => { throw new Error('Dismissal must not contact a Deployment'); };
    const dismissed = await m.run(['--dismiss-earlier-copies'], { fetch, agents: [] });
    expect(dismissed).toMatchObject({ ok: true, err: [] });
    expect(dismissed.out.filter(line => line.startsWith('Dismissed'))).toHaveLength(1);
    expect(dismissed.out.join('\n')).toContain(`homelab's history on ${SERVER}`);
    expect(fs.readFileSync(ledger.file)).toEqual(bytes);
    expect(fs.readFileSync(file)).toEqual(proof);
    const options = { homes: [m.legacyHome], homeDir: m.home };
    expect(observeLegacyStrayHistory(m.mycoHome, options)).toEqual([]);
    const preview = await m.run(['--dry-run', '--skip', PROJECT], { fetch: fetchBoth, agents: [] });
    expect(preview.ok).toBe(true);
    expect(preview.out.filter(line => line.includes('An earlier move also put'))).toEqual([]);
    ledger.append({ k: 'session', session: 'accepted-session' });
    expect(observeLegacyStrayHistory(m.mycoHome, options)).toEqual([]);
    ledger.append({ k: 'lineage', id: 'new-accepted-history' });
    expect(observeLegacyStrayHistory(m.mycoHome, options)).toHaveLength(1);
    expect(fs.readFileSync(file)).toEqual(proof);
  });

  it('raises new accepted history after a dismissed ledger is lost', async () => {
    const ledger = new LegacyLedger(m.mycoHome, SERVER, HOMELAB);
    ledger.append({ k: 'session', session: 'first-session' }, { k: 'session', session: 'second-session' });
    const file = path.join(m.mycoHome, 'member', 'cutover.json');
    writeJson(file, { backups: {}, migrations: { [m.vault]: { digest: 'earlier', size: 1, mtimeMs: 1, projects: {
      [HOMELAB]: { destinations: { [deploymentKeyFor(SERVER)]: { serverUrl: SERVER, digest: 'earlier', size: 1, mtimeMs: 1,
        evidence: { kind: 'deployment', at: 1, machineId: TEST_MACHINE_ID, eventIds: ['accepted-event'] },
      } } },
    } } } });
    fs.chmodSync(file, 0o600);
    const options = { homes: [m.legacyHome], homeDir: m.home };
    expect((await m.run(['--dismiss-earlier-copies'], { fetch: () => { throw new Error('No network calls'); }, agents: [] })).ok).toBe(true);
    expect(observeLegacyStrayHistory(m.mycoHome, options)).toEqual([]);
    fs.rmSync(ledger.file);
    ledger.append({ k: 'spore', id: 'new-accepted-spore' });
    expect(observeLegacyStrayHistory(m.mycoHome, options)).toHaveLength(1);
    ledger.append({ k: 'lineage', id: 'new-accepted-lineage' });
    expect(observeLegacyStrayHistory(m.mycoHome, options)).toHaveLength(1);
  });

  it('refuses unreadable earlier-copy acknowledgements without overwriting them', async () => {
    const ledger = new LegacyLedger(m.mycoHome, SERVER, HOMELAB);
    ledger.append({ k: 'session', session: 'accepted-session' });
    const file = path.join(m.mycoHome, 'member', 'legacy-earlier-copies.json');
    fs.writeFileSync(file, '{', { mode: 0o600 });
    const bytes = fs.readFileSync(ledger.file);
    const result = await m.run(['--dismiss-earlier-copies'], { fetch: () => { throw new Error('No network calls'); }, agents: [] });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('Earlier-copy acknowledgements could not be read');
    expect(fs.readFileSync(file, 'utf8')).toBe('{');
    expect(fs.readFileSync(ledger.file)).toEqual(bytes);
  });

  it('does not report skipped history as routed elsewhere', async () => {
    new LegacyLedger(m.mycoHome, SERVER, HOMELAB).append({ k: 'spore', id: 'accepted-spore' });
    const result = await m.run(['--dry-run', '--skip', HOMELAB], { fetch: fetchBoth, agents: [] });
    expect(result.ok).toBe(true);
    expect(result.out.filter(line => line.includes('An earlier move also put'))).toEqual([]);
  });

  it('omits earlier-copy lines for a refused receipt destination', () => {
    new LegacyLedger(m.mycoHome, SERVER, HOMELAB).append({ k: 'spore', id: 'accepted-spore' });
    const file = path.join(m.mycoHome, 'member', 'cutover.json');
    writeJson(file, { backups: {}, migrations: { [m.vault]: { digest: 'earlier', size: 1, mtimeMs: 1, projects: {
      [HOMELAB]: { destination: { serverUrl: SERVER, key: deploymentKeyFor(SERVER) }, vault: { state: 'partial', at: 1 } },
    } } } });
    fs.chmodSync(file, 0o600);
    const plan = planCutover(m.mycoHome, { legacyHomes: [m.legacyHome], homeDir: m.home }, { machineId: TEST_MACHINE_ID });
    expect(plan.blockers.join('\n')).toContain('its receipt names');
    expect(plan.strayHistory).toEqual([]);
  });

  it('refuses an unreadable binding at cutover without reporting its destination', async () => {
    new LegacyLedger(m.mycoHome, SERVER, HOMELAB).append({ k: 'spore', id: 'accepted-spore' });
    fs.writeFileSync(registryEntryPath(homelab, m.mycoHome), '{');
    const plan = planCutover(m.mycoHome, { legacyHomes: [m.legacyHome], homeDir: m.home }, { machineId: TEST_MACHINE_ID });
    expect(plan.blockers.join('\n')).toContain(`the binding at ${homelab} is unreadable`);
    expect(plan.strayHistory).toEqual([]);
    const result = await m.run(['--dry-run'], { fetch: fetchBoth, agents: [] });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('memberships or Project routes could not all be read');
    expect(result.out.filter(line => line.includes('An earlier move also put'))).toEqual([]);
  });

  it('does not report the current destination or a source choice without accepted history', async () => {
    new LegacyLedger(m.mycoHome, PERSONAL, HOMELAB).append({ k: 'spore', id: 'already-personal' });
    new LegacyLedger(m.mycoHome, SERVER, HOMELAB).append({ k: 'source', session: 'not-sent', from: 'vault' }, { k: 'reconciled', version: 1 });
    const result = await m.run(['--dry-run', '--skip', PROJECT], { fetch: fetchBoth, agents: [] });
    expect(result.ok).toBe(true);
    expect(result.out.filter(line => line.includes('An earlier move also put'))).toEqual([]);
  });

  it('still names an earlier copy after this machine leaves its Deployment', async () => {
    const ledger = new LegacyLedger(m.mycoHome, SERVER, HOMELAB);
    ledger.append({ k: 'lineage', id: 'earlier-lineage' });
    const before = fs.readFileSync(ledger.file);
    writeRegistryEntry({ version: 2, root: m.root, projectId: PROJECT, serverUrl: SERVER, token: m.rig.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    removeDeploymentForLogout(SERVER, crypto.createHash('sha256').update(m.rig.token).digest('hex'), logoutBindings(m.mycoHome), m.mycoHome);
    for (const args of [['--dry-run'], []]) {
      const result = await m.run([...args, '--skip', PROJECT], { fetch: fetchBoth, agents: [] });
      expect(result.err).toEqual([]); expect(result.ok).toBe(true);
      const lines = result.out.filter(line => line.includes('An earlier move also put'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`homelab's history on ${SERVER} (it now goes to ${PERSONAL})`);
      expect(lines[0]).toContain('This machine no longer belongs to that Deployment.');
      expect(fs.readFileSync(ledger.file)).toEqual(before);
    }
  });

  it('reports a departed ledger honestly when its address was not retained', async () => {
    const url = 'https://forgotten.invalid';
    new LegacyLedger(m.mycoHome, url, HOMELAB).append({ k: 'session', session: 'earlier-session' });
    const result = await m.run(['--dry-run', '--skip', PROJECT], { fetch: fetchBoth, agents: [] });
    expect(result.ok).toBe(true);
    const lines = result.out.filter(line => line.includes('An earlier move also put'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`a Deployment this machine has left (stored as ${deploymentKeyFor(url)}; its address was not kept)`);
    expect(lines[0]).toContain(`It now goes to ${PERSONAL}`);
    expect(lines[0]).toContain('a Deployment this machine has left');
  });

  it('status preserves the same completed destination as cutover after a repository rebind', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    new LegacyLedger(m.mycoHome, SERVER, HOMELAB).append({ k: 'session', session: 'earlier-work-copy' });
    writeRegistryEntry({ version: 2, root: homelab, projectId: HOMELAB, serverUrl: SERVER, token: m.rig.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    const preview = await m.run(['--dry-run'], { fetch: fetchBoth, agents: [] });
    expect(preview.ok).toBe(true);
    const lines = preview.out.filter(line => line.includes('An earlier move also put')).map(line => line.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`homelab's history on ${SERVER} (it now goes to ${PERSONAL})`);
    expect(observeLegacyStrayHistory(m.mycoHome, { homes: [m.legacyHome], homeDir: m.home })).toEqual(lines);
  });

  it('status reports the same default-derived destination as cutover for an unbound repository', async () => {
    fs.rmSync(registryEntryPath(homelab, m.mycoHome));
    recordDefaultDeployment(PERSONAL, { mycoHome: m.mycoHome, replace: true });
    new LegacyLedger(m.mycoHome, SERVER, HOMELAB).append({ k: 'session', session: 'earlier-work-copy' });
    const preview = await m.run(['--dry-run'], { fetch: fetchBoth, agents: [] });
    expect(preview.ok).toBe(true);
    const lines = preview.out.filter(line => line.includes('An earlier move also put')).map(line => line.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`homelab's history on ${SERVER} (it now goes to ${PERSONAL})`);
    expect(observeLegacyStrayHistory(m.mycoHome, { homes: [m.legacyHome], homeDir: m.home })).toEqual(lines);
  });

  it('reports earlier stray history through command dispatch', async () => {
    const oldServer = Bun.serve({ port: 0, fetch: request => m.rig.fetch(request) });
    const currentServer = Bun.serve({ port: 0, fetch: request => personal.fetch(request) });
    const oldUrl = oldServer.url.origin;
    const currentUrl = currentServer.url.origin;
    const unitDir = path.join(m.home, 'empty-unit-dir');
    fs.mkdirSync(unitDir);
    try {
      writeDeploymentMembership({ serverUrl: oldUrl, token: m.rig.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
      writeRegistryEntry({ version: 2, root: homelab, projectId: HOMELAB, serverUrl: currentUrl, token: personal.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
      const ledger = new LegacyLedger(m.mycoHome, oldUrl, HOMELAB);
      ledger.append({ k: 'spore', id: 'earlier-personal-spore' });
      const before = fs.readFileSync(ledger.file);
      const data = m.rig.env.sqlite.serialize();
      fs.writeFileSync(resolveMachineIdPath(m.mycoHome), TEST_MACHINE_ID);
      fs.mkdirSync(path.join(m.home, 'tmp'));
      const command = process.env.MYCO_CUTOVER_TEST_BINARY ? [process.env.MYCO_CUTOVER_TEST_BINARY] : [process.execPath, path.join(resolvePackageRoot(), 'src', 'cli.ts')];
      let dismissed = false;
      for (const args of [
        ['cutover', '--dry-run', '--legacy-home', m.legacyHome, '--skip', PROJECT],
        ['setup', '--status'],
        ['cutover', '--dismiss-earlier-copies', '--legacy-home', m.legacyHome],
        ['setup', '--status'],
      ]) {
        const child = Bun.spawn([...command, ...args], { cwd: m.home, stdout: 'pipe', stderr: 'pipe', env: {
          ...process.env, HOME: m.home, CODEX_HOME: path.join(m.home, '.codex'), CLAUDE_CONFIG_DIR: path.join(m.home, '.claude'),
          XDG_CONFIG_HOME: path.join(m.home, '.config'), MYCO_HOME: m.mycoHome, TMPDIR: path.join(m.home, 'tmp'), MYCO_LAUNCH_AGENTS_DIR: unitDir,
        } });
        const timeout = setTimeout(() => child.kill(), 20_000);
        try {
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          expect({ code, stderr }).toEqual({ code: args[0] === 'cutover' ? 0 : 3, stderr: '' });
          if (args.includes('--dismiss-earlier-copies')) { dismissed = true; expect(stdout).toContain(`Dismissed the earlier copy of homelab's history on ${oldUrl}`); }
          const lines = stdout.split('\n').filter(line => line.includes('An earlier move also put'));
          expect(lines).toHaveLength(dismissed ? 0 : 1);
          if (!dismissed) expect(lines[0]).toContain(`homelab's history on ${oldUrl} (it now goes to ${currentUrl})`);
          expect(fs.readFileSync(ledger.file)).toEqual(before);
          expect(m.rig.env.sqlite.serialize()).toEqual(data);
        } finally { clearTimeout(timeout); }
      }
    } finally { oldServer.stop(true); currentServer.stop(true); }
  });

  for (const { label, evidence, accepted } of [
    { label: 'confirmed', evidence: { kind: 'deployment', at: 1, machineId: 'earlier-machine', eventIds: [], sporeIds: ['confirmed-spore'] }, accepted: true },
    { label: 'choice only', evidence: undefined, accepted: false },
    { label: 'empty', evidence: { kind: 'deployment', at: 1, machineId: 'earlier-machine', eventIds: [] }, accepted: false },
    { label: 'malformed IDs', evidence: { kind: 'deployment', at: 1, machineId: 'earlier-machine', eventIds: [123] }, accepted: false },
    { label: 'blank ID', evidence: { kind: 'deployment', at: 1, machineId: 'earlier-machine', eventIds: [''], sporeIds: ['confirmed-spore'] }, accepted: false },
    { label: 'malformed optional IDs', evidence: { kind: 'deployment', at: 1, machineId: 'earlier-machine', eventIds: ['confirmed-event'], sporeIds: 'unreadable' }, accepted: false },
    { label: 'failed probe', evidence: { kind: 'failed', at: 1, machineId: 'earlier-machine', eventIds: ['unconfirmed-event'] }, accepted: false },
  ]) it(`uses only accepted archived Deployment proof: ${label}`, () => {
    const file = path.join(m.mycoHome, 'member', 'cutover.json');
    fs.writeFileSync(file, JSON.stringify({ backups: {}, migrations: { [m.vault]: { digest: 'current', size: 1, mtimeMs: 1, projects: {
      [HOMELAB]: { destination: { serverUrl: PERSONAL, key: deploymentKeyFor(PERSONAL) }, destinations: {
        [deploymentKeyFor(SERVER)]: { serverUrl: SERVER, digest: 'earlier', size: 1, mtimeMs: 1, evidence },
      } },
    } } } }), { mode: 0o600 });
    const before = fs.readFileSync(file);
    const projects = [{ projectId: HOMELAB, root: homelab, vault: m.vault, destination: { kind: 'destination' as const, serverUrl: PERSONAL } }];
    expect(legacyStrayHistoryLines(m.mycoHome, projects)).toHaveLength(accepted ? 1 : 0);
    if (accepted) {
      new LegacyLedger(m.mycoHome, SERVER, HOMELAB).append({ k: 'spore', id: 'confirmed-spore' });
      expect(legacyStrayHistoryLines(m.mycoHome, projects)).toHaveLength(1);
    }
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('previews first, then places homelab only on personal and every other project only on work', async () => {
    const requests: string[] = [];
    const fetch: MemberRig['fetch'] = (input, init) => { requests.push(new URL(new Request(input, init).url).pathname); return fetchBoth(input, init); };
    const before = sha(m.vault);
    const dry = await m.run(['--dry-run'], { fetch, agents: [] });
    expect(dry.ok).toBe(true); expect(requests.every(route => route === '/import/legacy-history')).toBe(true); expect(sha(m.vault)).toBe(before);
    expect(dry.out.join('\n')).toContain(`${HOMELAB} from ${m.vault}: to ${PERSONAL}`);
    expect(dry.out.join('\n')).toContain(`${PROJECT} from ${m.vault}: to ${SERVER}`);
    expect(fs.existsSync(path.join(m.mycoHome, 'member', 'cutover.json'))).toBe(false);
    const result = await m.run([], { fetch, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    for (const table of ['sessions', 'spores', 'events']) {
      expect(projectsOn(personal, table)).toEqual([{ project_id: HOMELAB }]);
      expect(projectsOn(m.rig, table)).toEqual([{ project_id: PROJECT }]);
    }
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
    const state = readCutoverState(m.mycoHome);
    expect(state.version).toBe(2);
    expect(state.migrations![m.vault].projects[HOMELAB].destination).toMatchObject({ serverUrl: PERSONAL });
    expect(state.migrations![m.vault].projects[PROJECT].destination).toMatchObject({ serverUrl: SERVER });
    expect(sha(m.vault)).toBe(before);
  });

  it('refuses to route a bound personal repository to the work default', async () => {
    const result = await m.run(['--route', `${HOMELAB}=${SERVER}`], { fetch: fetchBoth, agents: [] });
    expect(result.ok).toBe(false); expect(result.err.join('\n')).toContain(`routes to ${PERSONAL}`);
    expect(personal.rows('events')).toBe(0); expect(m.rig.rows('events')).toBe(0);
  });

  it('preserves skipped project spools byte for byte, and preserves the skip on retry', async () => {
    const spool = routedSpoolDir({ serverUrl: PERSONAL, projectId: HOMELAB }, m.mycoHome);
    fs.mkdirSync(spool, { recursive: true });
    fs.writeFileSync(path.join(spool, 'destination.json'), JSON.stringify({ serverUrl: PERSONAL, projectId: HOMELAB }), { mode: 0o600 });
    const file = path.join(spool, 'outbox.ndjson'); fs.writeFileSync(file, 'retained spool bytes');
    const before = sha(file);
    const first = await m.run(['--route', `${PROJECT}=${SERVER}`, '--skip', HOMELAB], { fetch: fetchBoth, agents: [] });
    expect(first.err).toEqual([]); expect(first.ok).toBe(true); expect(sha(file)).toBe(before);
    expect(personal.rows('events')).toBe(0);
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    expect(personal.rows('events')).toBe(0); expect(sha(file)).toBe(before);
    expect(readCutoverState(m.mycoHome).migrations![m.vault].projects[HOMELAB].destination).toMatchObject({ skip: true });
  });

  it('resumes after interruption between destinations without uploading the completed destination again', async () => {
    const stop = new AbortController();
    const interrupted: MemberRig['fetch'] = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).origin === PERSONAL && new URL(req.url).pathname !== '/import/legacy-history') stop.abort();
      return fetchBoth(req);
    };
    expect((await m.run([], { fetch: interrupted, signal: stop.signal, agents: [] })).ok).toBe(false);
    const state = readCutoverState(m.mycoHome);
    expect(state.migrations![m.vault].projects[PROJECT].vault?.state).toBe('complete');
    expect(state.migrations![m.vault].projects[HOMELAB].vault?.state).not.toBe('complete');
    let workUploads = 0;
    const resumed: MemberRig['fetch'] = (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).origin === SERVER && req.method === 'POST' && (new URL(req.url).pathname === '/events' || new URL(req.url).pathname.startsWith('/blobs/'))) workUploads += 1;
      return fetchBoth(req);
    };
    const result = await m.run([], { fetch: resumed, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true); expect(workUploads).toBe(0);
    expect(projectsOn(personal, 'sessions')).toEqual([{ project_id: HOMELAB }]);
  });

  it('upgrades a completed alpha backup-only record without a second upload', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    const record = path.join(m.mycoHome, 'member', 'cutover.json');
    const state = readCutoverState(m.mycoHome);
    fs.writeFileSync(record, JSON.stringify({ backups: state.backups }));
    expect(legacyMigrationState(m.mycoHome).state).toBe('needs-destination');
    let uploads = 0;
    const confirming: MemberRig['fetch'] = (input, init) => {
      const req = new Request(input, init); const route = new URL(req.url).pathname;
      if (req.method === 'POST' && (route === '/events' || route.startsWith('/blobs/'))) uploads += 1;
      return fetchBoth(req);
    };
    const result = await m.run([], { fetch: confirming, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true); expect(uploads).toBe(0);
    expect(readCutoverState(m.mycoHome).version).toBe(2); expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
  });

  it('refuses an undecided project and names route and skip commands', () => {
    fs.unlinkSync(path.join(m.mycoHome, 'member', 'default.json'));
    fs.unlinkSync(registryEntryPath(homelab, m.mycoHome));
    const plan = planCutover(m.mycoHome, { homeDir: m.home });
    expect(plan.blockers.join('\n')).toContain(`--route ${PROJECT}=<url> or --skip ${PROJECT}`);
  });

  it('reads local machine identity instead of a stored destination identity without writing during preview', () => {
    writeDeploymentMembership({ serverUrl: SERVER, token: m.rig.token, machineId: 'older-membership-machine', joinedAt: 1, updatedAt: 2 }, { mycoHome: m.mycoHome });
    const deps = { agents: () => [], unitDirs: [] };
    const before = sha(path.join(m.mycoHome, 'machine_id'));
    const plan = planCutover(m.mycoHome, { homeDir: m.home, dryRun: true }, deps);
    expect(plan.blockers).toEqual([]);
    expect(plan.machineId).toBe(TEST_MACHINE_ID);
    expect(sha(path.join(m.mycoHome, 'machine_id'))).toBe(before);
  });

  it('allows every project to be skipped without a membership or import identity', async () => {
    fs.rmSync(path.join(m.mycoHome, 'member', 'deployments'), { recursive: true, force: true });
    fs.unlinkSync(path.join(m.mycoHome, 'machine_id'));
    const db = new Database(m.vault);
    try { db.run("UPDATE sessions SET machine_id='retained-legacy-machine'"); db.run('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    const deps = { agents: () => [], unitDirs: [], stopDaemon: async () => 'none' as const, stdout: () => {}, stderr: () => {} };
    const plan = planCutover(m.mycoHome, { homeDir: m.home, skips: new Set([PROJECT, HOMELAB]) }, deps);
    expect(plan.blockers).toEqual([]);
    expect((await executeCutoverPlan(plan, deps)).ok).toBe(true);
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
    expect(fs.existsSync(path.join(m.mycoHome, 'machine_id'))).toBe(false);
  });

  it('hands over project-local legacy registrations at skipped roots while keeping foreign entries and history', async () => {
    const legacyMcp = path.join(homelab, '.cursor', 'mcp.json');
    const foreignMcp = path.join(homelab, '.codex', 'config.toml');
    writeJson(legacyMcp, { mcpServers: { myco: { command: `${m.legacyHome}/bin/myco`, args: ['mcp'] }, mine: { command: 'mine' } } });
    fs.mkdirSync(path.dirname(foreignMcp), { recursive: true });
    fs.writeFileSync(foreignMcp, '[mcp_servers.myco]\ncommand = "/foreign/bin/myco"\nargs = ["mcp"]\n');
    const foreignBefore = sha(foreignMcp), vaultBefore = sha(m.vault), legacyBefore = sha(legacyMcp);
    const preview = await m.run(['--skip', PROJECT, '--skip', HOMELAB, '--dry-run'], { agents: [] });
    expect(preview.err).toEqual([]); expect(preview.ok).toBe(true);
    expect(preview.out.join('\n')).toContain(legacyMcp);
    expect(sha(legacyMcp)).toBe(legacyBefore);
    const result = await m.run(['--skip', PROJECT, '--skip', HOMELAB], { agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(readJson(legacyMcp)).toEqual({ mcpServers: { mine: { command: 'mine' } } });
    expect(sha(foreignMcp)).toBe(foreignBefore); expect(sha(m.vault)).toBe(vaultBefore);
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
    expect(projectsOn(m.rig, 'sessions')).toEqual([]); expect(projectsOn(personal, 'sessions')).toEqual([]);
  });

  it('reports a skipped checkout that cannot safely hand over project registrations', () => {
    fs.rmSync(path.join(homelab, '.git'), { recursive: true });
    const plan = planCutover(m.mycoHome, { homeDir: m.home, skips: new Set([HOMELAB]) }, { agents: () => [], unitDirs: [] });
    expect(plan.blockers.join('\n')).toContain(`skipped folder ${homelab} is unsafe to inspect`);
  });

  it('does not let skipped foreign-machine sessions block routed spore history', async () => {
    const db = new Database(m.vault);
    try {
      db.run('PRAGMA foreign_keys=OFF');
      db.run('DELETE FROM prompt_batches WHERE project_id=?', [PROJECT]);
      db.run('DELETE FROM sessions WHERE project_id=?', [PROJECT]);
      db.run("UPDATE sessions SET machine_id='retained-legacy-machine' WHERE project_id=?", [HOMELAB]);
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
    const result = await m.run(['--skip', HOMELAB, '--route', `${PROJECT}=${SERVER}`], { fetch: fetchBoth, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(projectsOn(m.rig, 'spores')).toEqual([{ project_id: PROJECT }]);
    expect(projectsOn(personal, 'spores')).toEqual([]);
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
  });

  it('executes the exact revalidated preparation without a third agent discovery', async () => {
    let discoveries = 0;
    const deps = { agents: () => { discoveries += 1; return discoveries > 2 ? ['codex'] : []; }, unitDirs: [], stdout: () => {} };
    const plan = planCutover(m.mycoHome, { homeDir: m.home, dryRun: true }, deps);
    expect((await executeCutoverPlan(plan, deps)).ok).toBe(true);
    expect(discoveries).toBe(2);
    expect(fs.existsSync(path.join(m.home, '.codex', 'config.toml'))).toBe(false);
  });

  it('includes handover and copies in the preview and refuses newly added registrations', async () => {
    const deps = { agents: () => [], unitDirs: [], machineId: TEST_MACHINE_ID, stopDaemon: async () => 'none' as const };
    const plan = planCutover(m.mycoHome, { homeDir: m.home, dryRun: true }, deps);
    expect(plan.blockers).toEqual([]);
    expect(plan.handover.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.projects.find((p) => p.projectId === HOMELAB)?.counts).toMatchObject({ sessions: 1, spores: 1 });
    expect(plan.handover.flatMap((s) => s.actions).some((a) => a.outcomes.includes(`connect ${m.root}`))).toBe(true);
    expect(plan.copies).toEqual([expect.objectContaining({ vault: m.vault, reused: false })]);
    const settings = path.join(m.home, '.claude', 'settings.json');
    const config = readJson(settings) as { hooks: Record<string, unknown> };
    config.hooks.SessionEnd = [{ hooks: [{ type: 'command', command: `${m.legacyHome}/bin/myco hook session-end --myco-managed` }] }];
    writeJson(settings, config);
    const before = sha(settings);
    const errors: string[] = [];
    expect((await executeCutoverPlan(plan, { ...deps, stderr: (l) => errors.push(l) })).ok).toBe(false);
    expect(errors.join('\n')).toContain('handover actions changed after the preview');
    expect(sha(settings)).toBe(before);
    expect(fs.existsSync(path.join(m.mycoHome, 'member', 'cutover.json'))).toBe(false);
  });

  it('allows a vault write between planning and lease revalidation, then copies the latest history', async () => {
    const stopped: string[] = [];
    const deps = { fetch: fetchBoth, agents: () => [], unitDirs: [], machineId: TEST_MACHINE_ID, stdout: () => {},
      stopDaemon: async (home: string) => { stopped.push(home); return 'stopped' as const; } };
    const plan = planCutover(m.mycoHome, { homeDir: m.home }, deps);
    const db = new Database(m.vault);
    try { db.run("UPDATE spores SET content='changed' WHERE id='gotcha-1'"); } finally { db.close(); }
    const errors: string[] = [];
    expect((await executeCutoverPlan(plan, { ...deps, stderr: (l) => errors.push(l) })).ok).toBe(true);
    expect(errors).toEqual([]);
    expect(stopped).toContain(m.legacyHome);
    expect(m.rig.env.sqlite.query("SELECT content FROM spores WHERE id='gotcha-1'").get()).toEqual({ content: 'changed' });
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
  });

  for (const override of [null, 'MYCO_PROJECT_ROOT', 'MYCO_VAULT_DIR'] as const) for (const rootless of [false, true]) it(`requires a disposition for an unrouted ${rootless ? 'rootless' : 'absent'} project with ${override ?? 'no project override'}`, async () => {
    fs.rmSync(m.root, { recursive: true });
    if (rootless) {
      const db = new Database(m.vault);
      try { db.run('UPDATE sessions SET project_root=NULL WHERE project_id=?', [PROJECT]); } finally { db.close(); }
    }
    const held = override === null ? undefined : process.env[override];
    if (override !== null) process.env[override] = m.root;
    try {
      const plan = planCutover(m.mycoHome, { homeDir: m.home });
      expect(plan.projects.find(p => p.projectId === PROJECT)?.destination).toEqual({ kind: 'undecided' });
      expect(plan.blockers.join('\n')).toContain(`--route ${PROJECT}=<url> or --skip ${PROJECT}`);
      const explicit = await m.run(['--server', SERVER, '--dry-run'], { fetch: fetchBoth, agents: [] });
      expect(explicit.err).toEqual([]); expect(explicit.ok).toBe(true);
      expect(explicit.out.join('\n')).toContain(`${PROJECT} from ${m.vault}: to ${SERVER} (no repository route; sent to --server)`);
    } finally {
      if (override !== null) { if (held === undefined) delete process.env[override]; else process.env[override] = held; }
    }
  });

  it('refuses a repository rebound after the preview before any request or cutover record', async () => {
    const binding = { version: 2 as const, root: m.root, projectId: PROJECT, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 };
    writeRegistryEntry({ ...binding, serverUrl: SERVER, token: m.rig.token }, { mycoHome: m.mycoHome });
    let requests = 0;
    const errors: string[] = [];
    const deps = { fetch: ((input, init) => { requests += 1; return fetchBoth(input, init); }) as MemberRig['fetch'],
      agents: () => [], unitDirs: [], machineId: TEST_MACHINE_ID, stopDaemon: async () => 'none' as const,
      stdout: () => {}, stderr: (line: string) => errors.push(line) };
    const plan = planCutover(m.mycoHome, { homeDir: m.home }, deps);
    expect(plan.blockers).toEqual([]);
    expect(plan.projects.find(p => p.projectId === PROJECT)?.destination).toEqual({ kind: 'destination', serverUrl: SERVER });
    writeRegistryEntry({ ...binding, serverUrl: PERSONAL, token: personal.token }, { mycoHome: m.mycoHome });
    expect((await executeCutoverPlan(plan, deps)).ok).toBe(false);
    expect(errors.join('\n')).toContain('changed after the preview');
    expect(requests).toBe(0);
    expect(fs.existsSync(path.join(m.mycoHome, 'member', 'cutover.json'))).toBe(false);
  });

  it('names a present non-git folder in its destination blocker', () => {
    fs.rmSync(path.join(m.root, '.git'), { recursive: true });
    const plan = planCutover(m.mycoHome, { homeDir: m.home });
    expect(plan.projects.find(p => p.projectId === PROJECT)?.destination).toEqual({ kind: 'undecided' });
    expect(plan.blockers.join('\n')).toContain(`${m.root} is not a repository`);
    expect(plan.blockers.join('\n')).toContain(`--route ${PROJECT}=<url> or --skip ${PROJECT}`);
  });

  it('labels a present unbound repository destination as default-derived', async () => {
    const result = await m.run(['--dry-run'], { agents: [] });
    expect(result.ok).toBe(true);
    expect(result.out.join('\n')).toContain(`${PROJECT} from ${m.vault}: to ${SERVER} (default Deployment; no repository route)`);
  });

  it('does not carry completion to a re-routed destination when aborted before import', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    fs.rmSync(m.root, { recursive: true });
    fs.unlinkSync(registryEntryPath(m.root, m.mycoHome));
    const stopped = new AbortController();
    stopped.abort();
    const result = await m.run(['--route', `${PROJECT}=${PERSONAL}`], { fetch: fetchBoth, agents: [], signal: stopped.signal });
    expect(result.ok).toBe(false);
    const receipt = readCutoverState(m.mycoHome).migrations![m.vault].projects[PROJECT];
    expect(receipt.destination).toMatchObject({ serverUrl: PERSONAL });
    expect(receipt.vault?.state).not.toBe('complete');
    expect(legacyMigrationState(m.mycoHome).state).not.toBe('moved');
    expect(projectsOn(personal, 'sessions')).toEqual([{ project_id: HOMELAB }]);
  });

  it('refuses a real vault write across the copy before uploading anything', async () => {
    let copying = false;
    let reads = 0;
    const original = fs.statSync;
    const stat = spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: fs.StatOptions) => {
      const args = [file, options];
      if (copying && String(args[0]) === m.vault && ++reads === 2) {
        const db = new Database(m.vault);
        try { db.run("UPDATE spores SET content='write during copy' WHERE id='gotcha-1'"); } finally { db.close(); }
      }
      return Reflect.apply(original, fs, args);
    }) as typeof fs.statSync);
    const errors: string[] = [];
    try {
      const deps = { fetch: fetchBoth, agents: () => [], unitDirs: [], machineId: TEST_MACHINE_ID,
        stopDaemon: async () => 'none' as const, stderr: (line: string) => errors.push(line),
        stdout: (line: string) => { if (line.startsWith('7. ')) copying = true; } };
      const plan = planCutover(m.mycoHome, { homeDir: m.home }, deps);
      expect((await executeCutoverPlan(plan, deps)).ok).toBe(false);
      expect(errors.join('\n')).toContain('changed while it was copied');
      expect(m.rig.rows('events')).toBe(0); expect(personal.rows('events')).toBe(0);
    } finally { stat.mockRestore(); }
  });

  it('keeps an absent-root project on its confirmed destination after the default changes', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    fs.rmSync(m.root, { recursive: true }); fs.unlinkSync(registryEntryPath(m.root, m.mycoHome));
    recordDefaultDeployment(PERSONAL, { mycoHome: m.mycoHome, replace: true });
    const result = await m.run([], { fetch: fetchBoth, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(readCutoverState(m.mycoHome).migrations![m.vault].projects[PROJECT].destination).toMatchObject({ serverUrl: SERVER });
    expect(projectsOn(personal, 'sessions')).toEqual([{ project_id: HOMELAB }]);
  });

  it('refuses a deleted transcript directory claimed by work and personal records', async () => {
    writeRegistryEntry({ version: 2, root: m.root, projectId: PROJECT, serverUrl: SERVER, token: m.rig.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    const gone = path.join(m.home, 'deleted-ambiguous');
    for (const root of [m.root, homelab]) {
      const record = path.join(root, '.git', 'worktrees', 'claim');
      fs.mkdirSync(record, { recursive: true });
      fs.writeFileSync(path.join(record, 'gitdir'), `${gone}/.git\n`);
      fs.writeFileSync(path.join(record, 'commondir'), '../..\n');
    }
    const id = '00000000-0000-4000-8000-000000000004';
    const transcript = path.join(m.home, '.claude', 'projects', `-${rootSlug(gone)}`, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: gone, sessionId: id, message: { content: 'ambiguous transcript' }, timestamp: '2026-08-01T10:00:00Z' })}\n`);
    const old = new Date(Date.now() - 3 * 60 * 60_000); fs.utimesSync(transcript, old, old);
    const result = await m.run([], { fetch: fetchBoth, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(result.out.join('\n')).toContain(gone);
    for (const server of [m.rig, personal]) expect(server.env.sqlite.query('SELECT session_id FROM sessions WHERE session_id=?').all(id)).toEqual([]);
  });

  it('imports mapped transcripts from an absent checkout into its connected replacement', async () => {
    const replacement = path.join(m.home, 'Repos', 'replacement');
    fs.mkdirSync(replacement, { recursive: true }); execFileSync('git', ['init', '-q', replacement]);
    writeRegistryEntry({ version: 2, root: replacement, projectId: PROJECT, serverUrl: SERVER, token: m.rig.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    fs.rmSync(m.root, { recursive: true });
    const id = '00000000-0000-4000-8000-000000000003';
    const transcript = path.join(m.home, '.claude', 'projects', `-${rootSlug(m.root)}`, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: m.root, sessionId: id, message: { content: 'retained mapped transcript' }, timestamp: '2026-08-01T10:00:00Z' })}\n`);
    const old = new Date(Date.now() - 3 * 60 * 60_000); fs.utimesSync(transcript, old, old);
    const result = await m.run(['--map', `${m.root}=${replacement}`, '--route', `${PROJECT}=${SERVER}`], { fetch: fetchBoth, agents: [] });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(m.rig.env.sqlite.query('SELECT session_id FROM sessions WHERE session_id=?').all(id)).toEqual([{ session_id: id }]);
    expect(readCutoverState(m.mycoHome).migrations![m.vault].projects[PROJECT].transcripts?.state).toBe('complete');
  });

  it('receipts describe the verified copy after the last 1.4 write during handover', async () => {
    const result = await m.run([], { fetch: fetchBoth, agents: [], stopDaemon: async () => {
      const db = new Database(m.vault);
      try { db.run("UPDATE spores SET content='last 1.4 write' WHERE id='gotcha-1'"); db.run('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
      return 'stopped';
    } });
    expect(result.err).toEqual([]); expect(result.ok).toBe(true);
    expect(legacyMigrationState(m.mycoHome).state).toBe('moved');
  });

  it('refuses new project destinations that appear during handover before uploading anything', async () => {
    const result = await m.run([], { fetch: fetchBoth, agents: [], stopDaemon: async () => {
      const db = new Database(m.vault);
      try { db.run("UPDATE spores SET project_id='proj_new' WHERE id='gotcha-1'"); db.run('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
      return 'stopped';
    } });
    expect(result.ok).toBe(false); expect(result.err.join('\n')).toContain('projects or folders changed during handover');
    expect(m.rig.rows('events')).toBe(0); expect(personal.rows('events')).toBe(0);
  });

  it('keeps per-destination receipts when the source changes and a project is skipped', async () => {
    expect((await m.run([], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    const old = readCutoverState(m.mycoHome).migrations![m.vault];
    const db = new Database(m.vault);
    try { db.run("UPDATE spores SET content='later 1.4 write' WHERE id='gotcha-1'"); } finally { db.close(); }
    expect((await m.run(['--skip', PROJECT], { fetch: fetchBoth, agents: [] })).ok).toBe(true);
    const receipt = readCutoverState(m.mycoHome).migrations![m.vault].projects[PROJECT];
    expect(receipt.destination).toMatchObject({ skip: true });
    expect(receipt.destinations![deploymentKeyFor(SERVER)]).toMatchObject({ digest: old.digest, vault: { state: 'complete' } });
  });

  it('requires an explicit disposition when the old folder now belongs to another Project', () => {
    writeRegistryEntry({ version: 2, root: m.root, projectId: 'proj_unrelated', serverUrl: PERSONAL, token: personal.token, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: m.mycoHome });
    expect(planCutover(m.mycoHome, { homeDir: m.home }).blockers.join('\n')).toContain(`--route ${PROJECT}=<url> or --skip ${PROJECT}`);
    const explicit = planCutover(m.mycoHome, { homeDir: m.home, routes: new Map([[PROJECT, SERVER]]) });
    expect(explicit.blockers).toEqual([]);
    expect(explicit.projects.find((p) => p.projectId === PROJECT)?.destination).toEqual({ kind: 'destination', serverUrl: SERVER });
  });
});
