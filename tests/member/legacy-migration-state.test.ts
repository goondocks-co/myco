import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completedLegacyDestination, installedLegacyHooks, legacyMigrationState, type CutoverState } from '@myco/member/legacy-migration.js';
import { isMemberHome } from '@myco/member/home-role.js';
import { legacyVaultProjectIds, legacyVaultStamp } from '@myco/member/legacy-sources.js';
import { readLegacyVault } from '@myco/member/legacy-import.js';
import { deploymentKeyFor } from '@myco/member/registry.js';
import { readVaultContent } from '@myco/member/legacy-backup.js';
import { withLegacyBinaryTraps } from '../helpers/legacy-migration-fixture.js';

let root: string;
let home: string;
let userHome: string;
let previousHome: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-migration-state-'));
  home = path.join(root, 'member-home');
  userHome = path.join(root, 'operator');
  previousHome = process.env.HOME;
  process.env.HOME = userHome;
  fs.mkdirSync(path.join(home, 'member', 'deployments'), { recursive: true });
  fs.writeFileSync(path.join(home, 'member', 'deployments', 'fixture.json'), '{}', { mode: 0o600 });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function vault(mycoHome = home, grove = 'one'): string {
  const file = path.join(mycoHome, 'groves', grove, 'myco.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try { db.run("CREATE TABLE sessions (body TEXT, project_id TEXT DEFAULT 'proj_1')"); db.run("INSERT INTO sessions (body) VALUES ('retained')"); } finally { db.close(); }
  return file;
}

function backup(file: string, metadata = false, recordHome = home): void {
  const stat = fs.statSync(file);
  const evidence = metadata ? { size: stat.size, mtimeMs: stat.mtimeMs } : { digest: readVaultContent(file).digest };
  const record = path.join(recordHome, 'member', 'cutover.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ backups: { [file]: evidence } }), { mode: 0o600 });
}

it('requires destination receipts for a backup-only record even when its content digest matches', () => {
  const file = vault();
  expect(legacyMigrationState(home).state).toBe('unmoved');
  backup(file);
  expect(legacyMigrationState(home).state).toBe('needs-destination');
  const db = new Database(file);
  try { db.run("INSERT INTO sessions (body) VALUES ('new capture')"); } finally { db.close(); }
  expect(legacyMigrationState(home).state).toBe('needs-destination');
});

it('requires receipts rather than matching backup size and mtime evidence', () => {
  backup(vault(), true);
  expect(legacyMigrationState(home).state).toBe('needs-destination');
  vault(home, 'new');
  expect(legacyMigrationState(home).state).toBe('unmoved');
});

it('checks backup-only evidence across the default and target homes', () => {
  const defaultHome = path.join(userHome, '.myco');
  const file = vault(defaultHome);
  expect(legacyMigrationState(home).state).toBe('unmoved');
  backup(file);
  expect(legacyMigrationState(home).state).toBe('needs-destination');
  fs.unlinkSync(path.join(home, 'member', 'cutover.json'));
  backup(file, false, defaultHome);
  expect(legacyMigrationState(home).state).toBe('needs-destination');
});

it('names an unreadable cutover record instead of treating it as completion', () => {
  const file = vault();
  backup(file);
  const record = path.join(home, 'member', 'cutover.json');
  fs.writeFileSync(record, '{');
  const state = legacyMigrationState(home);
  expect(state).toMatchObject({ state: 'unavailable', file: record });
  if (state.state !== 'unavailable') throw new Error('expected unavailable migration evidence');
  expect(state.detail.split(`cannot read ${record}:`)).toHaveLength(2);
});

it.skipIf(process.platform === 'win32')('never executes a managed or PATH binary while observing legacy migration', async () => {
  vault();
  await withLegacyBinaryTraps(home, userHome, async (marker) => {
    expect(legacyMigrationState(home).state).toBe('unmoved');
    expect(fs.existsSync(marker)).toBe(false);
  });
});


function receipts(file: string, change: (state: CutoverState) => void = () => {}): CutoverState {
  const stamp = legacyVaultStamp(file);
  const state: CutoverState = {
    version: 2, backups: {}, handover: { at: 1, legacyHomes: [home], agents: [] },
    migrations: { [file]: { ...stamp, digest: readVaultContent(file).digest, projects: {
      proj_1: { destination: { serverUrl: 'https://work.invalid', key: deploymentKeyFor('https://work.invalid') }, vault: { state: 'complete', at: 1 }, transcripts: { state: 'complete', at: 1 } },
    } } },
  };
  change(state);
  fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify(state), { mode: 0o600 });
  return state;
}

function stateIs(state: ReturnType<typeof legacyMigrationState>['state']): void {
  expect(isMemberHome(home)).toBe(true);
  expect(legacyMigrationState(home).state).toBe(state);
}

function emptyVault(grove = 'empty'): string {
  const file = path.join(home, 'groves', grove, 'myco.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try { db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8')); } finally { db.close(); }
  expect(readLegacyVault(file)).toEqual([]);
  return file;
}

it('ignores an empty vault beside a fully receipted vault and preserves terminal notices', () => {
  const empty = emptyVault();
  const file = vault();
  const state = receipts(file, state => {
    state.migrations![file].projects.proj_1.transcripts = { state: 'none', at: 1, endedBy: 'project_archived' };
    delete state.handover;
    state.migrations![file].projects.proj_1.evidence = { kind: 'deployment', at: 1, machineId: 'fixture', eventIds: ['event'] };
  });
  state.backups[empty] = { copy: 'unused', ...readVaultContent(empty), at: 1 };
  fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify(state), { mode: 0o600 });
  const before = fs.readFileSync(empty);
  expect(legacyMigrationState(home)).toEqual({ state: 'moved', terminalProjects: [{ name: 'proj_1', state: 'archived' }] });
  expect(fs.readFileSync(empty)).toEqual(before);
});

it('reports none for an empty vault alone with a backup', () => {
  const file = emptyVault();
  backup(file);
  const before = fs.readFileSync(file);
  stateIs('none');
  expect(fs.readFileSync(file)).toEqual(before);
});

it('reports none for an empty vault without a backup', () => {
  const file = emptyVault();
  const before = fs.readFileSync(file);
  stateIs('none');
  expect(fs.readFileSync(file)).toEqual(before);
});

for (const kind of ['not SQLite', 'truncated'] as const) for (const backedUp of [false, true]) {
  it(`names an unreadable unreceipted ${kind} vault with ${backedUp ? 'a backup' : 'no backup'}`, () => {
    const file = vault();
    if (backedUp) backup(file);
    if (kind === 'not SQLite') fs.writeFileSync(file, 'not a SQLite database');
    else fs.truncateSync(file, fs.statSync(file).size / 2);
    const before = fs.readFileSync(file);
    expect(legacyMigrationState(home)).toMatchObject({ state: 'unavailable', file });
    expect(fs.readFileSync(file)).toEqual(before);
  });
}

for (const backedUp of [false, true]) it(`blocks a vault with an unassigned session and ${backedUp ? 'a backup' : 'no backup'}`, () => {
  const file = emptyVault();
  const db = new Database(file);
  try { db.run("INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('orphan', 'codex', 1, 1)"); } finally { db.close(); }
  expect(legacyVaultProjectIds(file)).toEqual([]);
  expect(readLegacyVault(file)).toEqual([]);
  if (backedUp) backup(file);
  const before = fs.readFileSync(file);
  stateIs(backedUp ? 'needs-destination' : 'unmoved');
  expect(fs.readFileSync(file)).toEqual(before);
});

const unassignedContent = [
  ['prompt', "INSERT INTO prompt_batches (id, session_id, created_at) VALUES ('prompt', 'missing', 1)"],
  ['plan', "INSERT INTO plans (id, logical_key, created_at) VALUES ('plan', 'key', 1)"],
  ['spore', "INSERT INTO spores (id, agent_id, observation_type, content, created_at) VALUES ('spore', 'agent', 'discovery', 'retained', 1)"],
  ['resolution', "INSERT INTO resolution_events (id, agent_id, spore_id, action, created_at) VALUES ('resolution', 'agent', 'missing', 'obsolete', 1)"],
  ['tombstone', "INSERT INTO session_tombstones (session_id, deleted_at, source) VALUES ('missing', 1, 'api_delete')"],
] as const;
for (const [kind, insert] of unassignedContent) it(`blocks a vault holding only an unassigned ${kind}`, () => {
  const file = emptyVault();
  const db = new Database(file);
  try { db.run(insert); } finally { db.close(); }
  expect(readLegacyVault(file)).toEqual([]);
  backup(file);
  const before = fs.readFileSync(file);
  stateIs('needs-destination');
  expect(fs.readFileSync(file)).toEqual(before);
});

it('reports none and unmoved after login without a receipt', () => {
  stateIs('none');
  vault(); stateIs('unmoved');
});

it('reports needs-destination after backups only', () => {
  backup(vault()); stateIs('needs-destination');
});

it('reports a partial import and preserves a terminal refusal cause', () => {
  const file = vault();
  receipts(file, (s) => { s.migrations![file].projects.proj_2 = {
    destination: { serverUrl: 'https://work.invalid', key: deploymentKeyFor('https://work.invalid') },
    vault: { state: 'refused', at: 1, failures: [{ what: 'session retained', cause: 'refused:403' }] },
  }; });
  stateIs('partial');
  expect(JSON.parse(fs.readFileSync(path.join(home, 'member', 'cutover.json'), 'utf8')).migrations[file].projects.proj_2.vault.failures[0].cause).toBe('refused:403');
});

it('reports unfinished migration instead of changed before any history was imported', () => {
  const file = vault();
  receipts(file, state => {
    const project = state.migrations![file].projects.proj_1;
    delete project.vault;
    delete project.transcripts;
  });
  const db = new Database(file);
  try { db.run("INSERT INTO sessions (body) VALUES ('final capture before stop')"); } finally { db.close(); }
  stateIs('partial');
});

it('refuses malformed stopped-source evidence', () => {
  const file = vault();
  receipts(file, state => { state.handover!.reconciliation = { before: '{}', after: 'broken', sessionsAdded: 1 }; });
  stateIs('unavailable');
});

it('reports changed after capture resumes, including WAL-only writes', () => {
  const file = vault(); receipts(file); stateIs('moved');
  const db = new Database(file);
  try {
    db.run('PRAGMA journal_mode=WAL');
    db.run("INSERT INTO sessions (body) VALUES ('later')");
    stateIs('changed');
    expect(legacyMigrationState(home)).toMatchObject({ warning: expect.stringContaining('myco setup --cutover') });
  } finally { db.close(); }
});

it('reports changed before needs-destination when new capture adds a project', () => {
  const file = vault(); receipts(file);
  const db = new Database(file);
  try { db.run("INSERT INTO sessions VALUES ('new project', 'proj_2')"); } finally { db.close(); }
  stateIs('changed');
});

it('reports handover-pending and moved after every project is skipped', () => {
  const file = vault();
  receipts(file, (s) => { delete s.handover; s.migrations![file].projects.proj_1 = { destination: { skip: true, at: 1 } }; });
  stateIs('handover-pending');
  receipts(file, (s) => { s.migrations![file].projects.proj_1 = { destination: { skip: true, at: 1 } }; });
  stateIs('moved');
});

it('uses completion for the current destination instead of a project-wide completion flag', () => {
  const file = vault();
  receipts(file, state => {
    const receipt = state.migrations![file];
    receipt.projects.proj_1.destinations = { [deploymentKeyFor('https://work.invalid')]: {
      serverUrl: 'https://work.invalid', digest: receipt.digest, size: receipt.size, mtimeMs: receipt.mtimeMs,
      vault: { state: 'partial', at: 2 }, transcripts: { state: 'complete', at: 1 },
    } };
  });
  stateIs('partial');
});

for (const version of [2, 1, undefined] as const) it(`reads ${version ?? 'unversioned'} completion independently of live routes and memberships`, () => {
  const file = vault();
  const state = receipts(file, state => { state.version = version; });
  const receipt = state.migrations![file];
  const project = receipt.projects.proj_1;
  expect(completedLegacyDestination(receipt, project)).toBe('https://work.invalid');
  stateIs('moved');
  for (const change of [
    () => { project.vault!.endedBy = 'refused'; },
    () => { delete project.vault!.endedBy; project.transcripts!.failures = [{ what: 'transcript', cause: 'fault' }]; },
  ]) {
    change();
    expect(completedLegacyDestination(receipt, project)).toBeNull();
  }
});

it.skipIf(process.platform === 'win32')('names loose record permissions', () => {
  const file = vault(); receipts(file);
  fs.chmodSync(path.join(home, 'member', 'cutover.json'), 0o644);
  stateIs('unavailable');
  expect(legacyMigrationState(home)).toMatchObject({ detail: expect.stringContaining('permissions must be 0600') });
});

it('compares vault aliases through realpath and uses metadata without opening an unchanged vault', () => {
  const file = vault();
  const alias = path.join(root, 'alias'); fs.symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  receipts(file, (s) => { s.migrations![path.join(alias, path.relative(home, file))] = s.migrations![file]; delete s.migrations![file]; });
  stateIs('moved');
  const stat = fs.statSync(file);
  fs.writeFileSync(file, Buffer.alloc(stat.size, 97));
  fs.utimesSync(file, stat.atime, stat.mtime);
  // Keep the exact platform mtime representation in the receipt.
  const record = path.join(home, 'member', 'cutover.json');
  const held = JSON.parse(fs.readFileSync(record, 'utf8')) as CutoverState;
  Object.values(held.migrations!)[0].mtimeMs = fs.statSync(file).mtimeMs;
  fs.writeFileSync(record, JSON.stringify(held));
  stateIs('moved');
});


it('refuses malformed skip and completion receipts', () => {
  const file = vault();
  receipts(file);
  const record = path.join(home, 'member', 'cutover.json');
  const held = JSON.parse(fs.readFileSync(record, 'utf8'));
  held.migrations[file].projects.proj_1 = { destination: { skip: true } };
  fs.writeFileSync(record, JSON.stringify(held)); stateIs('unavailable');
  receipts(file);
  const complete = JSON.parse(fs.readFileSync(record, 'utf8'));
  complete.migrations[file].projects.proj_1.vault = { state: 'complete' };
  fs.writeFileSync(record, JSON.stringify(complete)); stateIs('unavailable');
});

it('ignores stale hooks when deciding whether legacy capture still needs handover', () => {
  const settings = path.join(userHome, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: `${root}/deleted/bin/myco hook stop --myco-managed` }] }] } }));
  expect(installedLegacyHooks(home, { homeDir: userHome })).toBe(false);
});
