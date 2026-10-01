/**
 * Auto-join (#1547): a git repository this machine meets with no connection of its own joins the machine's default
 * Deployment by itself, through the real hooks and `myco member auto-join` against the in-process Deployment.
 *
 * Repositories are made under `target/`, inside the checkout: every temporary folder is one the machine never
 * captures, so a repository there would say nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import {
  AUTO_JOIN_RETRY_MS, isLeft, machineSalt, markSweepDone, placeRepository, releaseAutoJoinLock, readAutoJoinState, rootKeyFor, silentRepository, startSweep, type DetachedSpawn,
} from '@myco/member/auto-join.js';
import { readDefaultDeployment, recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { cacheMachineSettings } from '@myco/member/machine-settings.js';
import { readMissingMembership, recordMissingMembership } from '@myco/member/no-membership.js';
import { appendPending, appendPendingTurnEnd, expirePending, flushPending, listPending, PENDING_MAX_RECORDS, PENDING_TTL_MS, pendingDir, pendingSpool } from '@myco/member/pending.js';
import { readRegistryEntry, REGISTRY_VERSION, writeDeploymentMembership, writeRegistryEntry } from '@myco/member/registry.js';
import { MemberSpool } from '@myco/member/spool.js';
import { mintId, promptEvent, sessionStartEvent } from '@myco/member/envelope.js';
import { runAutoJoin } from '@myco/cli/member-auto-join.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { run as runMemberCli } from '@myco/cli/member.js';
import { memberRig, tempMycoHome, TEST_MACHINE_ID, type MemberRig } from './helpers/server.js';
import { recordingFetch, runHook } from './helpers/hooks.js';

const SERVER_URL = 'https://member-test.invalid';
const savedHome = process.env.MYCO_HOME;
const savedTemporary = process.env.MYCO_TEMPORARY_FOLDERS;
/** The one folder these tests treat as temporary, wherever the checkout lives. */
let temporary: string;
let mycoHome: string;
let rig: MemberRig;
let base: string;
let spawned: Array<{ command: string; args: readonly string[]; cwd: string; home: string | undefined }>;
const spawn: DetachedSpawn = (command, args, opts) => { spawned.push({ command, args, cwd: opts.cwd, home: opts.env.MYCO_HOME }); return true; };

/** A git repository under `parent`, with `origin` when a remote is named. */
function repository(parent: string, name: string, remote: string | null): string {
  const root = path.join(parent, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (remote !== null) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  return fs.realpathSync(root);
}

/** The machine's folders, as the Deployment holds them for it. */
function captureFolders(folders: string[]): void {
  rig.env.sqlite.run(`INSERT OR REPLACE INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?, 'capture.auto_join_roots', ?, 1, ?)`,
    [TEST_MACHINE_ID, JSON.stringify(folders), `mem_${TEST_MACHINE_ID}`]);
  cacheMachineSettings(SERVER_URL, { leaves: { 'capture.auto_join_roots': folders, 'capture.connect_roots': {} } }, mycoHome);
}

const transcript = (root: string, sessionId: string): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-auto-join-tx-')), `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: root, message: { role: 'user', content: 'hello' } })}\n`);
  return file;
};

const join = (args: string[]) => runAutoJoin(args, { mycoHome, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
const uncaptured = () => rig.env.sqlite.query(`SELECT root_key, label, reason, misses FROM uncaptured_roots ORDER BY label`).all() as Array<{ root_key: string; label: string; reason: string; misses: number }>;

beforeEach(async () => {
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-auto-join-temporary-')));
  process.env.MYCO_TEMPORARY_FOLDERS = temporary;
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  rig = await memberRig();
  rig.env.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (?, ?, ?)`, [TEST_MACHINE_ID, `mem_${TEST_MACHINE_ID}`, Date.now()]);
  writeDeploymentMembership({ serverUrl: SERVER_URL, token: rig.token, tokenId: rig.tokenId, memberId: `mem_${TEST_MACHINE_ID}`, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome });
  recordDefaultDeployment(SERVER_URL, { mycoHome });
  fs.mkdirSync(path.resolve('target'), { recursive: true });
  base = fs.realpathSync(fs.mkdtempSync(path.join(path.resolve('target'), 'auto-join-')));
  captureFolders([path.join(base, 'Repos')]);
  // The sweep over repositories met before auto-join has its own test; here it has run.
  markSweepDone(mycoHome, Date.now());
  spawned = [];
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  if (savedTemporary === undefined) delete process.env.MYCO_TEMPORARY_FOLDERS; else process.env.MYCO_TEMPORARY_FOLDERS = savedTemporary;
  resetMachineIdCache();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('where a repository stands', () => {
  it('never captures a temporary folder, an agent home, a Myco home, the home folder, or a folder no git work tree holds', () => {
    const tmpRepo = repository(fs.mkdtempSync(path.join(temporary, 'scratch-')), 'scratch', 'https://github.com/acme/scratch.git');
    expect(silentRepository(tmpRepo, { mycoHome })).toBe(true);
    expect(silentRepository(fs.realpathSync(os.homedir()), { mycoHome })).toBe(true);
    // The rest under a home folder outside every temporary folder: the checkout's own `target/`.
    const home = base;
    const away = path.join(base, 'away-home');
    // Every agent's own home, as the agents' manifests name them.
    for (const agent of ['.claude', '.codex', '.cursor', '.copilot', '.gemini', '.windsurf']) expect(silentRepository(repository(path.join(home, agent, 'projects'), 'x', null), { mycoHome: away, home })).toBe(true);
    expect(silentRepository(repository(path.join(home, '.myco-dev'), 'run', null), { mycoHome: away, home })).toBe(true);
    const namedHome = path.join(base, 'homes', 'smoke');
    expect(silentRepository(repository(path.join(namedHome, 'worker', 'runs'), 'r1', null), { mycoHome: namedHome, home })).toBe(true);
    expect(silentRepository(path.join(base, 'Repos', 'removed'), { mycoHome: away, home })).toBe(true);
    // The environment the hook runs in decides what counts as a project, not this process's.
    const plain = fs.mkdtempSync(path.join(path.parse(base).root, 'tmp', 'myco-auto-join-plain-'));
    expect(silentRepository(plain, { mycoHome: away, home, env: { MYCO_TEMPORARY_FOLDERS: temporary } })).toBe(true);
    expect(silentRepository(plain, { mycoHome: away, home, env: { MYCO_TEMPORARY_FOLDERS: temporary, MYCO_PROJECT_ROOT: plain } })).toBe(false);
    expect(silentRepository(repository(path.join(home, 'Repos'), 'widget', null), { mycoHome: away, home })).toBe(false);
    expect(silentRepository(repository(path.join(home, '.config'), 'dotfiles', null), { mycoHome: away, home })).toBe(false);
  });

  it('places a repository under a captured folder, one told to connect, and any other outside the folders', () => {
    const inside = repository(path.join(base, 'Repos'), 'widget', null);
    const outside = repository(path.join(base, 'elsewhere'), 'gadget', null);
    const leaves = { autoJoinRoots: [path.join(base, 'Repos')], connectRoots: {} };
    expect(placeRepository({ root: inside, rootKey: rootKeyFor(inside, mycoHome) }, leaves)).toBe('eligible');
    expect(placeRepository({ root: outside, rootKey: rootKeyFor(outside, mycoHome) }, leaves)).toBe('outside_folders');
    expect(placeRepository({ root: outside, rootKey: rootKeyFor(outside, mycoHome) }, { ...leaves, connectRoots: { [rootKeyFor(outside, mycoHome)]: '' } })).toBe('connected');
    // `~/` names a folder under the home folder; a relative entry names none.
    expect(placeRepository({ root: inside, rootKey: rootKeyFor(inside, mycoHome) }, { autoJoinRoots: ['~/Repos', 'Repos'], connectRoots: {} }, { home: base })).toBe('eligible');
    expect(placeRepository({ root: inside, rootKey: rootKeyFor(inside, mycoHome) }, { autoJoinRoots: ['Repos'], connectRoots: {} }, { home: base })).toBe('outside_folders');
  });
});

describe('a hook in a repository with no connection', () => {
  it('spools into the pending spool, dials nothing, and starts one join between concurrent hooks', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const spy = recordingFetch(rig.fetch);
    await runHook('session-start', { session_id: 'sess-a', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-a'), cwd: root }, { fetch: spy.fetch, spawn });
    await runHook('session-start', { session_id: 'sess-b', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-b'), cwd: root }, { fetch: spy.fetch, spawn });
    expect(spy.requests).toEqual([]);
    expect(spawned.map((s) => s.args.slice(-4))).toEqual([['auto-join', '--root', root, '--lock-held']]);
    expect(spawned[0]!.home).toBe(mycoHome);
    expect(listPending({ mycoHome, now: Date.now() }).map((p) => ({ root: p.root, sessions: p.sessions, records: p.records }))).toEqual([{ root, sessions: 2, records: 2 }]);
  });

  it('leaves the lock free when the join cannot be started, so the next hook starts one', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    await runHook('user-prompt-submit', { session_id: 'sess-f', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root }, { fetch: rig.fetch, spawn: () => false });
    await runHook('user-prompt-submit', { session_id: 'sess-f', hook_event_name: 'UserPromptSubmit', prompt: 'again', cwd: root }, { fetch: rig.fetch, spawn });
    expect(spawned).toHaveLength(1);
  });

  it('keys no plan to a project while the repository is still joining', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const plan = path.join(root, '.claude', 'plans', 'p.md');
    fs.mkdirSync(path.dirname(plan), { recursive: true });
    fs.writeFileSync(plan, '# A plan\n\nstep one\n');
    await runHook('post-tool-use', { session_id: 'sess-p', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: plan, content: '# A plan' }, cwd: root }, { fetch: rig.fetch, spawn });
    const pending = new MemberSpool('', { mycoHome, dir: pendingDir(rootKeyFor(root, mycoHome), mycoHome), initialize: false });
    expect(pending.sessionIds().flatMap((id) => pending.readRecords(id)).map((r) => (r !== null && "kind" in r ? r.kind : null))).toEqual([]);
  });

  it('says nothing and spools nothing in a repository the machine never captures', async () => {
    const root = repository(fs.mkdtempSync(path.join(temporary, 'scratch-')), 'scratch', 'https://github.com/acme/scratch.git');
    const hook = await runHook('user-prompt-submit', { session_id: 'sess-t', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root }, { fetch: rig.fetch, spawn });
    expect(hook.stdout).not.toContain('not capturing');
    expect(spawned).toEqual([]);
    expect(listPending({ mycoHome, now: Date.now() })).toEqual([]);
  });

  it('holds what a repository outside the folders captures, and tells the session once, after the join has read the folders', async () => {
    const root = repository(path.join(base, 'elsewhere'), 'gadget', 'https://github.com/acme/gadget.git');
    const prompt = (n: number) => runHook('user-prompt-submit', { session_id: 'sess-o', hook_event_name: 'UserPromptSubmit', prompt: `hi ${n}`, cwd: root }, { fetch: rig.fetch, spawn });
    await runHook('session-start', { session_id: 'sess-o', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-o'), cwd: root }, { fetch: rig.fetch, spawn });
    expect(listPending({ mycoHome, now: Date.now() }).map((p) => p.records)).toEqual([1]);
    expect((await join(['--root', root, '--lock-held']))[0]).toMatchObject({ result: 'outside_folders' });
    // Found outside: what was held stays held, for connecting it is the next step, and the session is told once.
    expect(listPending({ mycoHome, now: Date.now() }).map((p) => p.records)).toEqual([1]);
    const [first, second] = [await prompt(1), await prompt(2)];
    expect(first.stdout).toContain('outside the folders this machine captures');
    expect(first.stdout).toContain('held on this machine for 7 days');
    expect(second.stdout).not.toContain('not capturing');
    expect(spawned).toHaveLength(1);
  });

  it('captures the first session in a folder added on the dashboard before this machine has cached it', async () => {
    const root = repository(path.join(base, 'elsewhere'), 'gadget', 'https://github.com/acme/gadget.git');
    rig.env.sqlite.run(`INSERT OR REPLACE INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?, 'capture.auto_join_roots', ?, 1, ?)`,
      [TEST_MACHINE_ID, JSON.stringify([path.join(base, 'Repos'), path.join(base, 'elsewhere')]), `mem_${TEST_MACHINE_ID}`]);
    const started = await runHook('session-start', { session_id: 'sess-g', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-g'), cwd: root }, { fetch: rig.fetch, spawn });
    expect(started.stdout).not.toContain('not capturing');
    const prompted = await runHook('user-prompt-submit', { session_id: 'sess-g', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root }, { fetch: rig.fetch, spawn });
    expect(prompted.stderr).not.toContain('error');
    expect((await join(['--root', root, '--lock-held']))[0]).toMatchObject({ result: 'joined', moved: 1 });
    expect(rig.env.sqlite.query(`SELECT kind FROM events WHERE session_id = 'sess-g'`).all()).toEqual([{ kind: 'session.start' }]);
  });

  it('runs a prompt hook first in a repository with no connection without an error', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const hook = await runHook('user-prompt-submit', { session_id: 'sess-u', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, 'sess-u') }, { fetch: rig.fetch, spawn });
    expect(hook.stderr).not.toContain('error');
  });

  it('writes nothing to stderr and counts no missed membership while a repository holds its capture', async () => {
    const root = repository(path.join(base, 'elsewhere'), 'gadget', 'https://github.com/acme/gadget.git');
    const prompt = (session: string) => runHook('user-prompt-submit', { session_id: session, hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, session) }, { fetch: rig.fetch, spawn });
    const first = await prompt('sess-h1');
    expect((await join(['--root', root, '--lock-held']))[0]).toMatchObject({ result: 'outside_folders' });
    const told = await prompt('sess-h2');
    expect(told.stdout).toContain('outside the folders this machine captures');
    expect({ stderr: [first.stderr, told.stderr], missed: readMissingMembership(root, mycoHome), held: listPending({ mycoHome, now: Date.now() }).length })
      .toEqual({ stderr: ['', ''], missed: null, held: 1 });
    // Where auto-join has no say, the miss is still said and counted.
    const scratch = repository(fs.mkdtempSync(path.join(temporary, 'scratch-')), 'scratch', 'https://github.com/acme/scratch.git');
    const silent = await runHook('user-prompt-submit', { session_id: 'sess-h3', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: scratch }, { fetch: rig.fetch, spawn });
    expect({ said: silent.stderr.includes('no registry entry'), counted: readMissingMembership(scratch, mycoHome)?.count }).toEqual({ said: true, counted: 1 });
  });

  it('tries a refused repository again at once when this machine learns it was connected from "Needs you"', async () => {
    const root = repository(path.join(base, 'Repos'), 'notes', null);
    expect((await join(['--root', root]))[0]).toMatchObject({ result: 'missed', reason: 'no_remote' });
    const prompt = (n: number) => runHook('user-prompt-submit', { session_id: `sess-c${n}`, hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, `sess-c${n}`) }, { fetch: rig.fetch, spawn });
    await prompt(1);
    expect(spawned).toEqual([]);
    cacheMachineSettings(SERVER_URL, { leaves: { 'capture.auto_join_roots': [path.join(base, 'Repos')], 'capture.connect_roots': { [rootKeyFor(root, mycoHome)]: '' } } }, mycoHome);
    await prompt(2);
    expect(spawned.map((s) => s.args.slice(-3, -1))).toEqual([['--root', root]]);
  });

  it('tries a repository found outside the folders again at once when this machine\'s folders come to hold it', async () => {
    const root = repository(path.join(base, 'elsewhere'), 'gadget', 'https://github.com/acme/gadget.git');
    expect((await join(['--root', root]))[0]).toMatchObject({ result: 'outside_folders' });
    const prompt = (n: number) => runHook('user-prompt-submit', { session_id: `sess-m${n}`, hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, `sess-m${n}`) }, { fetch: rig.fetch, spawn });
    await prompt(1);
    expect(spawned).toEqual([]);
    captureFolders([path.join(base, 'Repos'), path.join(base, 'elsewhere')]);
    await prompt(2);
    expect(spawned.map((s) => s.args.slice(-3, -1))).toEqual([['--root', root]]);
  });
});

describe('myco member auto-join', () => {
  it('joins the project its remote names, or one created for it, moves the held capture there and delivers it', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    await runHook('session-start', { session_id: 'sess-j', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-j'), cwd: root }, { fetch: rig.fetch, spawn });
    const [result] = await join(['--root', root, '--lock-held']);
    expect(result).toMatchObject({ result: 'joined', moved: 1 });
    const projectId = (result as { projectId: string }).projectId;
    expect(readRegistryEntry(root, mycoHome)).toMatchObject({ projectId, serverUrl: SERVER_URL, token: rig.token });
    expect(rig.env.sqlite.query(`SELECT name FROM projects WHERE project_id = ?`).get(projectId)).toEqual({ name: 'widget' });
    expect(rig.env.sqlite.query(`SELECT project_id, kind FROM events WHERE session_id = 'sess-j'`).all()).toEqual([{ project_id: projectId, kind: 'session.start' }]);
    expect(fs.existsSync(pendingDir(rootKeyFor(root, mycoHome), mycoHome))).toBe(false);
    expect(readAutoJoinState(rootKeyFor(root, mycoHome), mycoHome)).toMatchObject({ outcome: 'joined', projectId });
    // The lock the hook handed over is released.
    expect(fs.readdirSync(path.join(mycoHome, 'member', 'auto-join')).filter((f) => f.endsWith('.lock'))).toEqual([]);

    // A second clone of the same repository joins the same project.
    const clone = repository(path.join(base, 'Repos', 'forks'), 'widget', 'git@github.com:acme/widget.git');
    expect((await join(['--root', clone]))[0]).toMatchObject({ result: 'joined', projectId });
  });

  it('reports a repository outside the folders for "Needs you" at most once a day', async () => {
    const root = repository(path.join(base, 'elsewhere'), 'gadget', 'https://github.com/acme/gadget.git');
    expect((await join(['--root', root]))[0]).toMatchObject({ result: 'outside_folders' });
    expect((await join(['--root', root]))[0]).toMatchObject({ result: 'outside_folders' });
    expect(uncaptured()).toEqual([{ root_key: rootKeyFor(root, mycoHome), label: 'gadget', reason: 'outside_folders', misses: 1 }]);
    expect(readRegistryEntry(root, mycoHome)).toBeNull();
  });

  it('holds a repository with no remote until it is connected from "Needs you", then joins and delivers what it held', async () => {
    const root = repository(path.join(base, 'Repos'), 'notes', null);
    await runHook('session-start', { session_id: 'sess-n', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-n'), cwd: root }, { fetch: rig.fetch, spawn });
    // The join the hook started, holding the lock the hook took.
    expect((await join(['--root', root, '--lock-held']))[0]).toMatchObject({ result: 'missed', reason: 'no_remote' });
    expect(uncaptured().map((r) => r.reason)).toEqual(['no_remote']);
    const told = await runHook('user-prompt-submit', { session_id: 'sess-n', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root }, { fetch: rig.fetch, spawn });
    expect(told.stdout).toContain('it has no git remote');
    expect(listPending({ mycoHome, now: Date.now() }).map((p) => p.records)).toEqual([1]);

    // Connected from "Needs you": the machine's next attempt joins a project created for it.
    rig.env.sqlite.run(`INSERT OR REPLACE INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?, 'capture.connect_roots', ?, 1, ?)`,
      [TEST_MACHINE_ID, JSON.stringify({ [rootKeyFor(root, mycoHome)]: '' }), `mem_${TEST_MACHINE_ID}`]);
    const [joined] = await join(['--root', root]);
    expect(joined).toMatchObject({ result: 'joined', moved: 1 });
    expect(uncaptured()).toEqual([]);
    expect(rig.env.sqlite.query(`SELECT kind FROM events WHERE session_id = 'sess-n'`).all()).toEqual([{ kind: 'session.start' }]);
  });

  it('does not create a project for a member while the Deployment keeps creation with admins, and says so', async () => {
    rig.env.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('capture.auto_create_projects', 'false', 1, 'mem_admin')`);
    rig.env.sqlite.run(`UPDATE members SET role = 'member' WHERE id = ?`, [`mem_${TEST_MACHINE_ID}`]);
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    expect((await join(['--root', root]))[0]).toMatchObject({ result: 'missed', reason: 'auto_create_off' });
    expect(rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM projects WHERE name = 'widget'`).get()).toEqual({ n: 0 });
    const told = await runHook('user-prompt-submit', { session_id: 'sess-x', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root }, { fetch: rig.fetch, spawn: () => true });
    expect(told.stdout).toContain('creates projects only on its dashboard');
  });

  it('leaves a repository a join already connected as it stands, wherever it lies, and reports none of it', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    await join(['--root', root]);
    const entry = readRegistryEntry(root, mycoHome);
    expect((await join(['--root', root]))[0]).toEqual({ root, result: 'connected' });
    expect(readRegistryEntry(root, mycoHome)).toEqual(entry);
    const elsewhere = repository(path.join(base, 'elsewhere'), 'gadget', 'https://github.com/acme/gadget.git');
    writeRegistryEntry({ version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: SERVER_URL, token: rig.token, root: elsewhere, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome });
    expect((await join(['--root', elsewhere]))[0]).toEqual({ root: elsewhere, result: 'connected' });
    expect(uncaptured()).toEqual([]);
  });

  it('reads the folders the Deployment holds now before deciding, not the ones this machine last cached', async () => {
    const root = repository(path.join(base, 'elsewhere'), 'gadget', 'https://github.com/acme/gadget.git');
    // The folder is added on the dashboard; this machine's cache still holds the old set.
    rig.env.sqlite.run(`INSERT OR REPLACE INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?, 'capture.auto_join_roots', ?, 1, ?)`,
      [TEST_MACHINE_ID, JSON.stringify([path.join(base, 'Repos'), path.join(base, 'elsewhere')]), `mem_${TEST_MACHINE_ID}`]);
    expect((await join(['--root', root]))[0]).toMatchObject({ result: 'joined' });
  });

  it('keeps a connection written while it asked, and writes none of its own', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    // `myco member join` connects the repository while the Deployment is answering the join.
    const racing: typeof rig.fetch = async (input, init) => {
      const answer = await rig.fetch(input, init);
      if (new Request(input, init).url.endsWith('/members/projects/resolve')) {
        writeRegistryEntry({ version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: SERVER_URL, token: rig.token, root, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome });
      }
      return answer;
    };
    expect((await runAutoJoin(['--root', root], { mycoHome, fetch: racing, stdout: () => {}, stderr: () => {} }))[0]).toEqual({ root, result: 'connected' });
    expect(readRegistryEntry(root, mycoHome)?.projectId).toBe('proj_1');
  });

  it('tries a repository that did not join again only after the retry gap', async () => {
    const root = repository(path.join(base, 'Repos'), 'notes', null);
    await join(['--root', root]);
    const state = readAutoJoinState(rootKeyFor(root, mycoHome), mycoHome)!;
    const hook = (at: number) => runHook('user-prompt-submit', { session_id: `sess-${at}`, hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root }, { fetch: rig.fetch, spawn, now: () => at });
    await hook(state.attemptAt + AUTO_JOIN_RETRY_MS - 1);
    expect(spawned).toEqual([]);
    await hook(state.attemptAt + AUTO_JOIN_RETRY_MS);
    expect(spawned).toHaveLength(1);
  });

  it('sweeps the repositories met before auto-join once: joins the ones it captures and reports the rest', async () => {
    const inside = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const outside = repository(path.join(base, 'elsewhere'), 'gadget', 'https://github.com/acme/gadget.git');
    const connected = repository(path.join(base, 'Repos'), 'held', 'https://github.com/acme/held.git');
    await join(['--root', connected]);
    for (const root of [inside, outside, connected]) recordMissingMembership(root, { mycoHome });
    fs.rmSync(path.join(mycoHome, 'member', 'auto-join', 'sweep.json'));
    // The first hook on the machine starts the sweep, once.
    await runHook('user-prompt-submit', { session_id: 'sess-w', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: inside }, { fetch: rig.fetch, spawn });
    expect(spawned.map((s) => s.args.slice(-4))).toEqual([['member', 'auto-join', '--sweep', '--lock-held'], ['auto-join', '--root', inside, '--lock-held']]);
    spawned = [];
    fs.rmSync(path.join(mycoHome, 'member', 'auto-join', 'sweep.lock'), { force: true });
    for (const lock of fs.readdirSync(path.join(mycoHome, 'member', 'auto-join')).filter((f) => f.endsWith('.lock'))) fs.rmSync(path.join(mycoHome, 'member', 'auto-join', lock));
    const results = await join(['--sweep']);
    expect(results.map((r) => [path.basename(r.root), r.result]).sort()).toEqual([['gadget', 'outside_folders'], ['widget', 'joined']]);
    expect(startSweep({ mycoHome, now: Date.now(), spawn })).toBe(false);
    expect(spawned).toEqual([]);
  });
});

describe('held capture reaches the project however the repository is connected', () => {
  const tx = (root: string, sessionId: string, lines: unknown[]): string => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-auto-join-tx-')), `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };
  const kindsOf = (sessionId: string) => (rig.env.sqlite.query(`SELECT kind FROM events WHERE session_id = ? AND producer_adapter <> 'transcript-parse' ORDER BY received_at, rowid`).all(sessionId) as Array<{ kind: string }>).map((r) => r.kind);

  it('a whole claude-code session held before the join ships its transcript once it joins, and the parse reads its turn', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const file = tx(root, 'sess-t', [
      { type: 'user', cwd: root, promptId: 'p1', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'held prompt' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'held reply' }], stop_reason: 'end_turn' } },
    ]);
    const raw = (hook: string) => ({ session_id: 'sess-t', hook_event_name: hook, transcript_path: file, cwd: root, prompt: 'held prompt', last_assistant_message: 'held reply' });
    for (const [hook, name] of [['session-start', 'SessionStart'], ['user-prompt-submit', 'UserPromptSubmit'], ['stop', 'Stop'], ['session-end', 'SessionEnd']] as const) {
      await runHook(hook, raw(name), { fetch: rig.fetch, spawn });
    }
    expect(kindsOf('sess-t')).toEqual([]);
    expect((await join(['--root', root, '--lock-held']))[0]).toMatchObject({ result: 'joined' });
    expect(kindsOf('sess-t')).toEqual(expect.arrayContaining(['session.start', 'session.end', 'transcript.segment']));
    await parseTranscripts(rig.env.serverEnv, Date.now());
    expect(rig.env.sqlite.query(`SELECT text FROM prompt_batches WHERE session_id = 'sess-t'`).all()).toEqual([{ text: 'held prompt' }]);
  });

  it('a hook-sourced session keeps its prompt across the join: the tool call after the join names the prompt held before it', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const file = tx(root, 'sess-h', [{ type: 'user', message: { role: 'user', content: 'x' } }]);
    const hook = (name: Parameters<typeof runHook>[0], raw: Record<string, unknown>) =>
      runHook(name, { session_id: 'sess-h', cwd: root, transcript_path: file, ...raw }, { fetch: rig.fetch, spawn, symbiont: 'copilot' });
    await hook('session-start', { hook_event_name: 'SessionStart' });
    await hook('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'held prompt' });
    expect((await join(['--root', root, '--lock-held']))[0]).toMatchObject({ result: 'joined' });
    await hook('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } });
    await hook('stop', { hook_event_name: 'Stop', last_assistant_message: 'done' });
    const prompts = rig.env.sqlite.query(`SELECT prompt_id FROM prompt_batches WHERE session_id = 'sess-h'`).all() as Array<{ prompt_id: string }>;
    expect(prompts).toHaveLength(1);
    expect(rig.env.sqlite.query(`SELECT prompt_id FROM tool_calls WHERE session_id = 'sess-h'`).all()).toEqual([{ prompt_id: prompts[0]!.prompt_id }]);
  });

  it('myco member join delivers what was held, and the Deployment forgets the repository', async () => {
    const root = repository(path.join(base, 'Repos'), 'notes', null);
    await runHook('session-start', { session_id: 'sess-m', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-m'), cwd: root }, { fetch: rig.fetch, spawn });
    expect((await join(['--root', root, '--lock-held']))[0]).toMatchObject({ result: 'missed', reason: 'no_remote' });
    expect(uncaptured()).toHaveLength(1);
    await runMemberCli(['join', '--project', 'proj_1', '--root', root, '--no-agents'], { mycoHome, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
    expect(uncaptured()).toEqual([]);
    expect(listPending({ mycoHome, now: Date.now() })).toEqual([]);
    await runMemberCli(['drain', '--all'], { mycoHome, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
    expect(kindsOf('sess-m')).toEqual(['session.start']);
  });

  it('a join that stopped after writing the connection leaves nothing stranded: a drain moves and delivers it', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    await runHook('session-start', { session_id: 'sess-d', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-d'), cwd: root }, { fetch: rig.fetch, spawn });
    writeRegistryEntry({ version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: SERVER_URL, token: rig.token, root, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome });
    await runMemberCli(['drain', '--all'], { mycoHome, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
    expect(listPending({ mycoHome, now: Date.now() })).toEqual([]);
    expect(kindsOf('sess-d')).toEqual(['session.start']);
  });

  it('a join that stopped after writing the connection leaves nothing stranded: the next hook there moves and delivers it', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    await runHook('session-start', { session_id: 'sess-c', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-c'), cwd: root }, { fetch: rig.fetch, spawn });
    // The connection is written, and the process dies before it moves what was held.
    writeRegistryEntry({ version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: SERVER_URL, token: rig.token, root, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome });
    await runHook('user-prompt-submit', { session_id: 'sess-c', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, 'sess-c2') }, { fetch: rig.fetch, spawn });
    await runHook('stop', { session_id: 'sess-c', hook_event_name: 'Stop', cwd: root, transcript_path: transcript(root, 'sess-c3'), last_assistant_message: 'x' }, { fetch: rig.fetch, spawn });
    expect(listPending({ mycoHome, now: Date.now() })).toEqual([]);
    expect(kindsOf('sess-c')).toEqual(expect.arrayContaining(['session.start']));
  });
});

describe('what a machine sends about a repository', () => {
  it('carries a key, a folder name, a remote with no credentials, a reason, its hold and a session count, and nothing naming a path', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://deploy:ghp_secret@github.com:8443/acme/widget.git');
    const outside = repository(path.join(base, 'elsewhere'), 'gadget', 'git@github.com:acme/gadget.git');
    const spy = recordingFetch(rig.fetch);
    for (const r of [root, outside]) await runAutoJoin(['--root', r], { mycoHome, fetch: spy.fetch, stdout: () => {}, stderr: () => {} });
    const sent = spy.requests.filter((r) => r.path.startsWith('/members/projects/resolve') || r.path.startsWith('/members/uncaptured')).map((r) => JSON.parse(r.body!) as Record<string, unknown>);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const body of sent) {
      expect(Object.keys(body).every((k) => ['rootKey', 'label', 'remote', 'reason', 'state', 'held', 'sessions'].includes(k))).toBe(true);
      const text = JSON.stringify(body);
      for (const forbidden of [base, os.homedir(), 'ghp_secret', 'deploy:', '8443']) expect(text).not.toContain(forbidden);
    }
    expect(rig.env.sqlite.query(`SELECT remote FROM project_remotes ORDER BY remote`).all()).toEqual([{ remote: 'github.com/acme/widget' }]);
  });

  it('keys a repository with this machine\'s salt: another machine\'s key for the same path is another key', () => {
    const root = repository(path.join(base, 'Repos'), 'widget', null);
    const other = tempMycoHome();
    expect(rootKeyFor(root, mycoHome)).toMatch(/^[0-9a-f]{32}$/);
    expect(rootKeyFor(root, mycoHome)).toBe(rootKeyFor(root, mycoHome));
    expect(rootKeyFor(root, other)).not.toBe(rootKeyFor(root, mycoHome));
  });
});

describe('a capture folder reached through a link', () => {
  it('holds the repositories under the folder it links to', () => {
    const real = path.join(base, 'Repos');
    const link = path.join(base, 'linked-repos');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, link);
    const root = repository(real, 'widget', null);
    expect(placeRepository({ root, rootKey: rootKeyFor(root, mycoHome) }, { autoJoinRoots: [link], connectRoots: {} })).toBe('eligible');
  });
});

describe('a repository that keeps missing', () => {
  const prompt = (root: string, sessionId: string) =>
    runHook('user-prompt-submit', { session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, sessionId) }, { fetch: rig.fetch, spawn });
  const row = () => rig.env.sqlite.query(`SELECT reason, held, misses FROM uncaptured_roots`).get() as { reason: string; held: string; misses: number } | null;

  it('is tried again only once its settings change, not on every hook, and the session is told why', async () => {
    rig.env.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('capture.auto_create_projects', 'false', 1, 'mem_admin')`);
    rig.env.sqlite.run(`UPDATE members SET role = 'member' WHERE id = ?`, [`mem_${TEST_MACHINE_ID}`]);
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const key = rootKeyFor(root, mycoHome);
    // Connected from "Needs you", and still refused: the Deployment keeps creation with admins.
    rig.env.sqlite.run(`INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?, 'capture.connect_roots', ?, 1, ?)`, [TEST_MACHINE_ID, JSON.stringify({ [key]: '' }), `mem_${TEST_MACHINE_ID}`]);
    expect((await join(['--root', root]))[0]).toMatchObject({ result: 'missed', reason: 'auto_create_off' });
    const hooks = [];
    for (let i = 0; i < 4; i += 1) hooks.push(await prompt(root, `sess-${i}`));
    expect(spawned).toEqual([]);
    expect(hooks[0]!.stdout).toContain('creates projects only on its dashboard');
    // Told to connect it to a named project now: tried at once.
    cacheMachineSettings(SERVER_URL, { leaves: { 'capture.auto_join_roots': [path.join(base, 'Repos')], 'capture.connect_roots': { [key]: 'proj_1' } } }, mycoHome);
    await prompt(root, 'sess-5');
    expect(spawned).toHaveLength(1);
  });

  it('waits twice as long after each repeat of the same miss, to an hour, and starts over on a new reason', async () => {
    const root = repository(path.join(base, 'Repos'), 'notes', null);
    const key = rootKeyFor(root, mycoHome);
    const waits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      await join(['--root', root]);
      const state = readAutoJoinState(key, mycoHome)!;
      waits.push(Math.round((state.nextAttemptAt! - state.attemptAt) / 60_000));
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, 60, 60]);
    // A hook starts no attempt before the backed-off one is due.
    const last = readAutoJoinState(key, mycoHome)!;
    const at = (t: number) => runHook('user-prompt-submit', { session_id: `sess-${t}`, hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, `sess-${t}`) }, { fetch: rig.fetch, spawn, now: () => t });
    await at(last.attemptAt + AUTO_JOIN_RETRY_MS);
    expect(spawned).toEqual([]);
    await at(last.nextAttemptAt!);
    expect(spawned).toHaveLength(1);
    spawned = [];
    releaseAutoJoinLock(key, mycoHome);
    rig.env.sqlite.run(`INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?, 'capture.auto_join_roots', ?, 1, ?) ON CONFLICT (machine_id, leaf) DO UPDATE SET value = excluded.value`,
      [TEST_MACHINE_ID, JSON.stringify([path.join(base, 'elsewhere')]), `mem_${TEST_MACHINE_ID}`]);
    await join(['--root', root]);
    const after = readAutoJoinState(key, mycoHome)!;
    expect({ outcome: after.outcome, wait: Math.round((after.nextAttemptAt! - after.attemptAt) / 60_000) }).toEqual({ outcome: 'outside_folders', wait: 2 });
  });

  it('keeps the hold the machine reports on its row across attempts, and counts sessions, not attempts', async () => {
    const root = repository(path.join(base, 'Repos'), 'busy', null);
    const repo = { root, rootKey: rootKeyFor(root, mycoHome) };
    const at = Date.now();
    await prompt(root, 'sess-a');
    await prompt(root, 'sess-b');
    await prompt(root, 'sess-b');
    await join(['--root', root, '--lock-held']);
    expect(row()).toEqual({ reason: 'no_remote', held: 'held', misses: 2 });
    const ctx = { agent: 'claude-code', sessionId: 'sess-f', stage: pendingSpool(repo, { mycoHome, now: at })!.stagerFor('sess-f'), now: () => at };
    appendPending(repo, 'sess-f', Array.from({ length: PENDING_MAX_RECORDS }, () => sessionStartEvent(ctx, { startedAt: at, originPath: root })), undefined, { mycoHome, now: at });
    pendingSpool(repo, { mycoHome, now: at });
    await join(['--root', root]);
    expect(row()).toEqual({ reason: 'no_remote', held: 'full', misses: 2 });
    // A second attempt says the same: the row stays full.
    await join(['--root', root]);
    expect(row()).toEqual({ reason: 'no_remote', held: 'full', misses: 2 });
  });
});

describe('a repository left with myco member leave', () => {
  it('captures, holds and says nothing until it is joined or connected again, and the Deployment forgets it', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const key = rootKeyFor(root, mycoHome);
    expect((await join(['--root', root]))[0]).toMatchObject({ result: 'joined' });
    await runHook('session-start', { session_id: 'sess-0', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-0'), cwd: root }, { fetch: rig.fetch, spawn });
    // It had been connected from "Needs you": leaving forgets that too, here and on the Deployment.
    rig.env.sqlite.run(`INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by) VALUES (?, 'capture.connect_roots', ?, 1, ?)`, [TEST_MACHINE_ID, JSON.stringify({ [key]: '' }), `mem_${TEST_MACHINE_ID}`]);
    cacheMachineSettings(SERVER_URL, { leaves: { 'capture.auto_join_roots': [path.join(base, 'Repos')], 'capture.connect_roots': { [key]: '' } } }, mycoHome);
    await runMemberCli(['leave', '--root', root], { mycoHome, cwd: root, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
    // The Deployment is told without waiting; give it the moment it takes.
    const told = () => (rig.env.sqlite.query(`SELECT value FROM machine_settings WHERE leaf = 'capture.connect_roots'`).get() as { value: string }).value;
    for (let i = 0; i < 100 && told() !== '{}'; i += 1) await Bun.sleep(10);
    expect(told()).toBe('{}');
    const hook = await runHook('user-prompt-submit', { session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, 'sess-1') }, { fetch: rig.fetch, spawn });
    expect({ spawned, pending: listPending({ mycoHome, now: Date.now() }), notice: hook.stdout.includes('not capturing'), stderr: hook.stderr, missed: readMissingMembership(root, mycoHome) })
      .toEqual({ spawned: [], pending: [], notice: false, stderr: '', missed: null });
    // Connected again from "Needs you": captured again.
    cacheMachineSettings(SERVER_URL, { leaves: { 'capture.auto_join_roots': [path.join(base, 'Repos')], 'capture.connect_roots': { [key]: '' } } }, mycoHome);
    await runHook('user-prompt-submit', { session_id: 'sess-2', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: root, transcript_path: transcript(root, 'sess-2') }, { fetch: rig.fetch, spawn });
    expect(spawned).toHaveLength(1);
  });

  it('is joined again by myco member join, which ends the opt-out', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    await join(['--root', root]);
    await runMemberCli(['leave', '--root', root], { mycoHome, cwd: root, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
    expect(isLeft(rootKeyFor(root, mycoHome), mycoHome)).toBe(true);
    await runMemberCli(['join', '--project', 'proj_1', '--root', root, '--no-agents'], { mycoHome, fetch: rig.fetch, stdout: () => {}, stderr: () => {} });
    expect(isLeft(rootKeyFor(root, mycoHome), mycoHome)).toBe(false);
  });
});

describe('the machine salt', () => {
  it('is one salt among racing processes, never read part-written, and a broken one is replaced rather than hashed with', async () => {
    const script = path.join(mycoHome, 'salt.ts');
    const module = path.resolve('packages/myco/src/member/auto-join.ts');
    fs.writeFileSync(script, `import { machineSalt } from ${JSON.stringify(module)};\nprocess.stdout.write(machineSalt(${JSON.stringify(mycoHome)}));\n`);
    const racers = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'ignore' }));
    const salts = await Promise.all(racers.map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
    expect(new Set(salts).size).toBe(1);
    expect(salts[0]).toMatch(/^[0-9a-f]{64}$/);
    // A salt cut short by a crash of a build that wrote it in place.
    const other = tempMycoHome();
    fs.mkdirSync(path.join(other, 'member', 'auto-join'), { recursive: true });
    fs.writeFileSync(path.join(other, 'member', 'auto-join', 'salt'), '');
    expect(machineSalt(other)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the pending spool', () => {
  it('discards held capture once it is older than the TTL, and refuses more past the record cap', () => {
    const root = repository(path.join(base, 'Repos'), 'widget', null);
    const repo = { root, rootKey: rootKeyFor(root, mycoHome) };
    const at = Date.now();
    const ctx = { agent: 'claude-code', sessionId: 'sess-p', stage: pendingSpool(repo, { mycoHome, now: at })!.stagerFor('sess-p'), now: () => at };
    expect(appendPending(repo, 'sess-p', [sessionStartEvent(ctx, { startedAt: at, originPath: root })], undefined, { mycoHome, now: at })).toBe('pending');
    expect(expirePending(repo.rootKey, { mycoHome, now: at + PENDING_TTL_MS - 1 })).toBe(false);
    expect(listPending({ mycoHome, now: at + PENDING_TTL_MS - 1 })).toHaveLength(1);
    expect(listPending({ mycoHome, now: at + PENDING_TTL_MS })).toEqual([]);
    expect(fs.existsSync(pendingDir(repo.rootKey, mycoHome))).toBe(false);

    const many = Array.from({ length: PENDING_MAX_RECORDS }, () => sessionStartEvent(ctx, { startedAt: at, originPath: root }));
    expect(appendPending(repo, 'sess-p', many, undefined, { mycoHome, now: at })).toBe('pending');
    expect(pendingSpool(repo, { mycoHome, now: at })).toBeNull();
    expect(appendPending(repo, 'sess-q', [sessionStartEvent({ ...ctx, sessionId: 'sess-q' }, { startedAt: at, originPath: root })], undefined, { mycoHome, now: at })).toBe('full');
  });

  it('moves a held session\'s journal in its order: events and the turn-end marks between them', () => {
    const root = repository(path.join(base, 'Repos'), 'widget', null);
    const repo = { root, rootKey: rootKeyFor(root, mycoHome) };
    const at = Date.now();
    const held = pendingSpool(repo, { mycoHome, now: at })!;
    const ctx = { agent: 'claude-code', sessionId: 'sess-j', stage: held.stagerFor('sess-j'), now: () => at };
    appendPending(repo, 'sess-j', [sessionStartEvent(ctx, { startedAt: at, originPath: root })], undefined, { mycoHome, now: at });
    new MemberSpool('', { mycoHome, dir: pendingDir(repo.rootKey, mycoHome) }).appendTurnEnd('sess-j', { slot: 'primary', transcriptId: `tx_${'a'.repeat(32)}`, atSize: 10 }, undefined, at + 1);
    appendPending(repo, 'sess-j', [sessionStartEvent(ctx, { startedAt: at + 2, originPath: root })], undefined, { mycoHome, now: at + 2 });
    const into = new MemberSpool('proj_1', { mycoHome });
    expect(flushPending(repo.rootKey, into, { mycoHome, now: at + 3 })).toBe(2);
    expect(into.readRecords('sess-j').map((r) => (r === null ? null : 'kind' in r ? r.kind : 'turn-end'))).toEqual(['session.start', 'turn-end', 'session.start']);
  });

  it('lands a hook\'s capture after what was held, when the connection is written but not yet settled', () => {
    const root = repository(path.join(base, 'Repos'), 'widget', null);
    const repo = { root, rootKey: rootKeyFor(root, mycoHome) };
    const at = Date.now();
    const ctx = (sessionId: string) => ({ agent: 'claude-code', sessionId, stage: pendingSpool(repo, { mycoHome, now: at })!.stagerFor(sessionId), now: () => at });
    appendPending(repo, 'sess-o', [sessionStartEvent(ctx('sess-o'), { startedAt: at, originPath: root })], undefined, { mycoHome, now: at });
    // The join wrote the connection and has not moved the held capture.
    writeRegistryEntry({ version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: SERVER_URL, token: rig.token, root, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome });
    const late = promptEvent({ ...ctx('sess-o'), now: () => at + 1 }, { promptId: mintId(), text: 'after' });
    expect(appendPending(repo, 'sess-o', [late], undefined, { mycoHome, now: at + 1 })).toBe('project');
    expect(new MemberSpool('proj_1', { mycoHome }).readRecords('sess-o').map((r) => (r !== null && 'kind' in r ? r.kind : null))).toEqual(['session.start', 'prompt']);
  });

  it('holds each turn-end mark once, however often a move appends it', () => {
    const root = repository(path.join(base, 'Repos'), 'widget', null);
    const repo = { root, rootKey: rootKeyFor(root, mycoHome) };
    const mark = { slot: 'primary' as const, transcriptId: `tx_${'b'.repeat(32)}`, atSize: 42 };
    expect(appendPendingTurnEnd(repo, 'sess-k', mark, undefined, { mycoHome, now: 1 })).toBe('pending');
    const into = new MemberSpool('proj_1', { mycoHome });
    into.appendTurnEnd('sess-k', mark, undefined, 1);
    flushPending(repo.rootKey, into, { mycoHome, now: 2 });
    into.appendTurnEnd('sess-k', mark, undefined, 3);
    expect(into.readRecords('sess-k').filter((r) => r !== null && !('kind' in r))).toHaveLength(1);
  });

  it('lands a hook\'s capture in the project\'s spool when the join connects the repository while the hook runs', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    const repo = { root, rootKey: rootKeyFor(root, mycoHome) };
    const at = Date.now();
    // The hook began before the join: it reads the pending spool and stages through it.
    const stage = pendingSpool(repo, { mycoHome, now: at })!.stagerFor('sess-r');
    const [joined] = await join(['--root', root]);
    const projectId = (joined as { projectId: string }).projectId;
    expect(appendPending(repo, 'sess-r', [sessionStartEvent({ agent: 'claude-code', sessionId: 'sess-r', stage, now: () => at }, { startedAt: at, originPath: root })], undefined, { mycoHome, now: at })).toBe('project');
    expect(new MemberSpool(projectId, { mycoHome }).readRecords('sess-r').map((r) => (r !== null && "kind" in r ? r.kind : null))).toEqual(['session.start']);
    expect(listPending({ mycoHome, now: at })).toEqual([]);
  });

  it('says when it holds nothing more, past the cap or with age: in the session, in status, and on the Deployment\'s row', async () => {
    const full = repository(path.join(base, 'Repos'), 'busy', null);
    const old = repository(path.join(base, 'Repos'), 'stale', null);
    const at = Date.now();
    const ctx = (root: string) => ({ agent: 'claude-code', sessionId: 'sess-f', stage: pendingSpool({ root, rootKey: rootKeyFor(root, mycoHome) }, { mycoHome, now: at })!.stagerFor('sess-f'), now: () => at });
    const many = Array.from({ length: PENDING_MAX_RECORDS }, () => sessionStartEvent(ctx(full), { startedAt: at, originPath: full }));
    appendPending({ root: full, rootKey: rootKeyFor(full, mycoHome) }, 'sess-f', many, undefined, { mycoHome, now: at });
    appendPending({ root: old, rootKey: rootKeyFor(old, mycoHome) }, 'sess-f', [sessionStartEvent(ctx(old), { startedAt: at, originPath: old })], undefined, { mycoHome, now: at - PENDING_TTL_MS - 1 });
    for (const root of [full, old]) await join(['--root', root]);
    const prompt = await runHook('user-prompt-submit', { session_id: 'sess-n1', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: full, transcript_path: transcript(full, 'sess-n1') }, { fetch: rig.fetch, spawn });
    expect(prompt.stdout).toContain('is no longer held');
    // The cap is found by the hook, the age by any read of the spool; the next attempt tells the Deployment.
    listPending({ mycoHome, now: at });
    for (const root of [full, old]) await join(['--root', root]);
    expect(rig.env.sqlite.query(`SELECT label, held FROM uncaptured_roots ORDER BY label`).all()).toEqual([{ label: 'busy', held: 'full' }, { label: 'stale', held: 'expired' }]);
    // Told once: a later attempt says it no more.
    const spy = recordingFetch(rig.fetch);
    await runAutoJoin(['--root', full], { mycoHome, fetch: spy.fetch, stdout: () => {}, stderr: () => {} });
    expect(spy.requests.filter((r) => r.path === '/members/uncaptured/state')).toEqual([]);
    const lines: string[] = [];
    await runMemberCli(['status', '--all'], { mycoHome, stdout: (l) => lines.push(l), stderr: () => {} });
    expect(lines.filter((l) => l.startsWith('held no more:')).map((l) => l.split(' — ')[0])).toEqual(expect.arrayContaining([`held no more: ${full}`, `held no more: ${old}`]));
  });

  it('is shown by `myco member status`, with when it is discarded', async () => {
    const root = repository(path.join(base, 'Repos'), 'widget', null);
    await runHook('session-start', { session_id: 'sess-s', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-s'), cwd: root }, { fetch: rig.fetch, spawn });
    await join(['--root', root, '--lock-held']);
    const lines: string[] = [];
    await runMemberCli(['status', '--all'], { mycoHome, stdout: (l) => lines.push(l), stderr: () => {} });
    expect(lines).toContain(`default:    ${SERVER_URL} (new repositories join it)`);
    expect(lines.some((l) => l.startsWith(`not joined: ${root} — no_remote`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`pending:    ${root} — 1 event(s) in 1 session(s) waiting to join since`) && l.includes('discarded after'))).toBe(true);
  });
});

describe('the default Deployment', () => {
  it('is recorded when none is, and moved only when asked', () => {
    expect(recordDefaultDeployment('https://other.invalid', { mycoHome })).toBe(false);
    expect(readDefaultDeployment(mycoHome)?.serverUrl).toBe(SERVER_URL);
    expect(recordDefaultDeployment('https://other.invalid', { mycoHome, replace: true })).toBe(true);
    expect(readDefaultDeployment(mycoHome)?.serverUrl).toBe('https://other.invalid');
  });

  it('is what a hook joins through: with none recorded, a hook in a repository with no connection does what it did before', async () => {
    fs.rmSync(path.join(mycoHome, 'member', 'default.json'));
    const root = repository(path.join(base, 'Repos'), 'widget', 'https://github.com/acme/widget.git');
    await runHook('session-start', { session_id: 'sess-d', hook_event_name: 'SessionStart', transcript_path: transcript(root, 'sess-d'), cwd: root }, { fetch: rig.fetch, spawn });
    expect(spawned).toEqual([]);
    expect(listPending({ mycoHome, now: Date.now() })).toEqual([]);
  });
});
