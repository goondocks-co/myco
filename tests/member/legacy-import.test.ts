/**
 * Importing a Myco 1.4 vault into a Deployment, against the real worker.
 *
 * The properties this is judged by:
 *
 *   - every vault session lands once, under the id its harness names, whether
 *     the vault stored that id, a hashed id with the transcript's path, the
 *     transcript's whole file name, another harness's path, or no path at all
 *     but a start time a transcript on disk shares;
 *   - its prompts come from exactly one source, decided once: the transcript
 *     where one is on disk or already held, the vault only where neither is;
 *   - its 1.4 title and summary land, and never over a title an administrator
 *     set; a session live capture already recorded keeps its facts and end;
 *   - spores keep their ids, status and time; their history keeps its time,
 *     and replaying it changes nothing;
 *   - a session a person deleted in 1.4 is left out of the vault import and of
 *     every transcript import after it; a session 1.4 retired for its own
 *     reasons is only left out of the vault import;
 *   - a session whose prompts came from the vault takes no transcript, on any
 *     machine, because the Deployment records it;
 *   - a refusal is reported, never counted as delivered;
 *   - running it again changes nothing, and sends nothing a Deployment refuses
 *     or retries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  groupLegacySessions, legacySessionId, legacyVaultFiles, readLegacyVault, runLegacyImport, LEGACY_PRODUCER, UNREACHABLE,
} from '@myco/member/legacy-import.js';
import { collectCandidates, importUntilSettled, paced, IMPORT_WAIT_CAP_MS, SERVER_FAULT_RETRIES } from '@myco/member/import.js';
import { legacySessionsToLeaveOut } from '@myco/member/legacy-ledger.js';
import { planKeyForPath } from '@myco/member/envelope.js';
import { writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION } from '@myco/member/registry.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { enumerateTranscripts, sessionIdFromStoredId, sessionIdFromTranscriptPath } from '@myco/symbionts/transcript-discovery.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { memberRig, tempMycoHome, TEST_MACHINE_ID, type MemberRig } from './helpers/server.js';
import { legacyImportComplete, legacyReportLines, run as runImportCli } from '@myco/cli/import.js';

const SERVER = 'https://member-test.invalid';
const PROJECT = 'proj_1';
const DAY_S = 86_400;
const NOW_S = Math.floor(Date.now() / 1000);
const at = (daysAgo: number) => NOW_S - daysAgo * DAY_S;
const iso = (seconds: number, ms = 0) => new Date(seconds * 1000 + ms).toISOString();

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SESSION_ON_DISK = UUID(1);
const SESSION_PRUNED = UUID(2);
const CODEX_ROLLOUT = '019dea98-5347-7f62-9d6f-3642db11931e';
const PI_UUID = '019ed19b-85fe-7df9-b24f-f0b69ebad031';
const PI_STORED = `2026-06-16T18-04-51-070Z_${PI_UUID}`;
const SESSION_DELETED = UUID(5);
const SESSION_LIVE = UUID(6);
const SESSION_ADMIN = UUID(7);
const SESSION_CURSOR = UUID(8);
const SESSION_TWICE = UUID(9);
const SESSION_RETIRED = UUID(10);
const SESSION_ACTIVE = UUID(12);
const SESSION_ELSEWHERE = UUID(11);
const UNMATCHED_DELETE = 'sess_00000000000000000000000000000eee';
const PI_SAME_SECOND = '019da14f-4dc1-73c8-845a-b1af6b207dba';
const PI_RAN_THEN = '019de5b4-cd62-76bf-8430-8f37da948654';

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

interface Fixture {
  rig: MemberRig;
  mycoHome: string;
  home: string;
  root: string;
  vault: string;
  liveEnd: number;
  run: (opts?: { dryRun?: boolean; fetch?: MemberRig['fetch']; mycoHome?: string; sleep?: (ms: number) => Promise<void> }) => ReturnType<typeof runLegacyImport>;
  /** `myco import --legacy <vault>`: whether it succeeded, and what it printed. */
  cli: (opts?: { fetch?: MemberRig['fetch']; mycoHome?: string }) => Promise<{ ok: boolean; out: string[] }>;
  bind: (mycoHome: string) => void;
  snapshot: () => Record<string, unknown>;
  cleanup: () => void;
}

/** A 1.4 vault built with the 1.4 schema, holding one project and every session shape the import meets. */
function buildVault(dir: string, root: string, home: string): string {
  const file = path.join(dir, 'groves', 'grove_test', 'myco.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openDatabase(file);
  createSchema(db);
  // The rows stand alone: the agents and entities a real vault's foreign keys name are not what this reads.
  db.run('PRAGMA foreign_keys = OFF');
  const session = (id: string, agent: string, startedAt: number, extra: Record<string, unknown> = {}) => {
    const row = {
      id, agent, project_root: root, project_id: PROJECT, branch: 'feat/x', started_at: startedAt, ended_at: startedAt + 600,
      status: 'completed', title: `Title of ${id}`, summary: `Summary of ${id}`, transcript_path: null, created_at: startedAt, machine_id: TEST_MACHINE_ID, ...extra,
    };
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(row) as never[]);
  };
  const prompt = (id: number, sessionId: string, text: string, response: string | null, startedAt: number) => {
    db.run(`INSERT INTO prompt_batches (id, project_id, session_id, prompt_number, user_prompt, response_summary, origin, kind, started_at, ended_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'human', 'initial', ?, ?, ?)`,
      [id, PROJECT, sessionId, id, text, response, startedAt, startedAt + 30, startedAt]);
  };
  const claudePath = (id: string) => path.join(home, '.claude', 'projects', `-${rootSlug(root)}`, `${id}.jsonl`);

  session(SESSION_ON_DISK, 'claude-code', at(40), { transcript_path: claudePath(SESSION_ON_DISK) });
  prompt(1, SESSION_ON_DISK, 'on disk prompt', 'on disk reply', at(40));
  session(SESSION_PRUNED, 'claude-code', at(39), { transcript_path: claudePath(SESSION_PRUNED) });
  prompt(2, SESSION_PRUNED, 'pruned prompt one', 'pruned reply one', at(39));
  prompt(3, SESSION_PRUNED, 'pruned prompt two', null, at(39));
  // One Codex rollout stored twice: a hashed id with the rollout's path, and the rollout id itself, later.
  const rollout = path.join(home, '.codex', 'sessions', '2026', '04', '30', `rollout-2026-04-30T10-00-00-${CODEX_ROLLOUT}.jsonl`);
  session('sess_5cd3531754d0313a2b88b7faa4f4b574', 'codex', at(38), { transcript_path: rollout, title: 'Older codex title' });
  session(CODEX_ROLLOUT, 'codex', at(37), { transcript_path: rollout, title: 'Codex title' });
  prompt(4, 'sess_5cd3531754d0313a2b88b7faa4f4b574', 'older codex prompt', null, at(38));
  prompt(5, CODEX_ROLLOUT, 'codex prompt', 'codex reply', at(37));
  session(PI_STORED, 'pi', at(36));
  prompt(6, PI_STORED, 'pi prompt', null, at(36));
  session(SESSION_DELETED, 'claude-code', at(35), { transcript_path: claudePath(SESSION_DELETED) });
  prompt(7, SESSION_DELETED, 'deleted prompt', null, at(35));
  db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'api_delete')`, [SESSION_DELETED, PROJECT, at(34)]);
  // 1.4 retired a session for its own reasons: not imported from the vault, and its transcript is still welcome.
  session(SESSION_RETIRED, 'claude-code', at(34), { transcript_path: claudePath(SESSION_RETIRED) });
  prompt(20, SESSION_RETIRED, 'retired prompt', null, at(34));
  db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'maintenance_sweep')`, [SESSION_RETIRED, PROJECT, at(34)]);
  // A person deleted a session whose row 1.4 removed, under an id no layout resolves.
  db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'api_delete')`, [UNMATCHED_DELETE, PROJECT, at(34)]);
  // Another machine captured this one.
  session(SESSION_ELSEWHERE, 'claude-code', at(34), { machine_id: 'machine_2' });
  prompt(21, SESSION_ELSEWHERE, 'elsewhere prompt', null, at(34));
  session(SESSION_LIVE, 'claude-code', at(33), { title: 'Vault title for live', branch: 'vault-branch' });
  prompt(8, SESSION_LIVE, 'live prompt from vault', null, at(33));
  session(SESSION_ADMIN, 'claude-code', at(32), { title: 'Vault title for admin' });
  // Recorded as Claude Code, but the transcript it names is Cursor's.
  session(SESSION_CURSOR, 'claude-code', at(31), { transcript_path: path.join(home, '.cursor', 'projects', 'p', 'agent-transcripts', SESSION_CURSOR, `${SESSION_CURSOR}.jsonl`) });
  prompt(9, SESSION_CURSOR, 'cursor prompt from vault', null, at(31));
  // One pruned Claude session stored twice: the earlier row holds the title and the prompts, the later row neither.
  session('sess_0000000000000000000000000000aaaa', 'claude-code', at(30), { transcript_path: claudePath(SESSION_TWICE), title: 'Earlier title', summary: 'Earlier summary' });
  session(SESSION_TWICE, 'claude-code', at(30) + 60, { title: null, summary: null });
  prompt(10, 'sess_0000000000000000000000000000aaaa', 'earlier prompt', null, at(30));
  // Pi sessions 1.4 stored under a hashed id with no path: one whose transcript starts in the same second,
  // one whose transcript was being written at that time, one with no transcript at all.
  session('sess_0000000000000000000000000000bbbb', 'pi', at(20));
  session('sess_0000000000000000000000000000cccc', 'pi', at(19));
  session('sess_0000000000000000000000000000dddd', 'pi', at(18));
  prompt(11, 'sess_0000000000000000000000000000dddd', 'orphan pi prompt', null, at(18));
  // A session whose transcript is still being written when the import runs.
  session(SESSION_ACTIVE, 'claude-code', at(1), { transcript_path: claudePath(SESSION_ACTIVE) });
  prompt(12, SESSION_ACTIVE, 'active prompt from vault', null, at(1));

  db.run(`INSERT INTO plans (id, project_id, logical_key, status, title, content, source_path, tags, session_id, created_at, updated_at)
          VALUES (?, ?, ?, 'completed', 'File plan', '# File plan', '.claude/plans/p.md', 'a, b', ?, ?, ?)`,
    ['plan_file', PROJECT, `session:${SESSION_PRUNED}:file:.claude/plans/p.md`, SESSION_PRUNED, at(39), at(39) + 60]);
  db.run(`INSERT INTO plans (id, project_id, logical_key, status, title, content, source_path, tags, session_id, created_at, updated_at)
          VALUES (?, ?, ?, 'active', 'Key plan', '# Key plan', NULL, NULL, ?, ?, ?)`,
    ['plan_key', PROJECT, `session:${CODEX_ROLLOUT}:key:rollout-plan`, CODEX_ROLLOUT, at(37), at(37) + 60]);
  db.run(`INSERT INTO plans (id, project_id, logical_key, status, title, content, source_path, tags, session_id, created_at, updated_at)
          VALUES (?, ?, ?, 'active', 'Deleted plan', '# Deleted', NULL, NULL, ?, ?, ?)`,
    ['plan_deleted', PROJECT, `session:${SESSION_DELETED}:key:gone`, SESSION_DELETED, at(35), at(35)]);

  const spore = (id: string, agent: string, status: string, sessionId: string | null, promptBatch: number | null) =>
    db.run(`INSERT INTO spores (id, project_id, agent_id, session_id, prompt_batch_id, observation_type, status, content, importance, tags, created_at)
            VALUES (?, ?, ?, ?, ?, 'gotcha', ?, ?, 7, 'x, y', ?)`, [id, PROJECT, agent, sessionId, promptBatch, status, `content of ${id}`, at(30)]);
  spore('gotcha-old', 'myco-agent', 'superseded', SESSION_PRUNED, 2);
  spore('gotcha-new', 'myco-agent', 'active', SESSION_PRUNED, 2);
  spore('decision-user', 'user', 'active', null, null);
  spore('gotcha-part', 'myco-agent', 'consolidated', CODEX_ROLLOUT, null);
  spore('wisdom-whole', 'myco-agent', 'active', null, null);
  spore('gotcha-of-deleted', 'myco-agent', 'active', SESSION_DELETED, 7);
  const resolution = (id: string, sporeId: string, action: string, newSporeId: string | null, daysAgo: number) =>
    db.run(`INSERT INTO resolution_events (id, project_id, agent_id, spore_id, action, new_spore_id, reason, created_at) VALUES (?, ?, 'myco-agent', ?, ?, ?, 'why', ?)`,
      [id, PROJECT, sporeId, action, newSporeId, at(daysAgo)]);
  resolution('res_1', 'gotcha-old', 'supersede', 'gotcha-new', 29);
  resolution('res_2', 'gotcha-part', 'consolidate', 'wisdom-whole', 28);
  resolution('res_bad', 'decision-user', 'supersede', null, 27);
  db.close();
  return file;
}

/** The transcripts still on disk. */
function buildTranscripts(home: string, root: string): string[] {
  const files: string[] = [];
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); files.push(file); };
  const claudeDir = path.join(home, '.claude', 'projects', `-${rootSlug(root)}`);
  const claude = (id: string, prompt: string) => line({ type: 'user', cwd: root, sessionId: id, promptId: UUID(900), message: { content: `${prompt} ${'x'.repeat(5000)}` }, timestamp: '2026-08-01T10:00:00Z' })
    + line({ type: 'assistant', cwd: root, message: { content: [{ type: 'text', text: 'reply from disk' }] }, timestamp: '2026-08-01T10:00:01Z' });
  write(path.join(claudeDir, `${SESSION_ON_DISK}.jsonl`), claude(SESSION_ON_DISK, 'transcript prompt'));
  write(path.join(claudeDir, `${SESSION_DELETED}.jsonl`), claude(SESSION_DELETED, 'deleted transcript prompt'));
  write(path.join(claudeDir, `${SESSION_RETIRED}.jsonl`), claude(SESSION_RETIRED, 'retired transcript prompt'));
  write(path.join(home, '.codex', 'sessions', '2026', '04', '30', `rollout-2026-04-30T10-00-00-${CODEX_ROLLOUT}.jsonl`),
    line({ type: 'session_meta', payload: { id: CODEX_ROLLOUT, cwd: root, source: 'cli', originator: 'codex-tui' } }) + line({ type: 'event_msg', payload: { type: 'user_message', message: `codex from disk ${'y'.repeat(5000)}` } }));
  write(path.join(home, '.cursor', 'projects', 'p', 'agent-transcripts', SESSION_CURSOR, `${SESSION_CURSOR}.jsonl`),
    line({ role: 'user', message: { content: [{ type: 'text', text: `cursor from disk ${'c'.repeat(5000)}` }] } }));
  const piDir = path.join(home, '.pi', 'agent', 'sessions', `--${rootSlug(root)}--`);
  const pi = (id: string, first: string, last: string) =>
    line({ type: 'session', id, cwd: root, timestamp: first }) + line({ type: 'message', timestamp: last, message: { role: 'user', content: `pi from disk ${'z'.repeat(5000)}` } });
  write(path.join(piDir, `${PI_STORED}.jsonl`), pi(PI_UUID, '2026-06-16T18:04:51.070Z', '2026-06-16T18:05:51.070Z'));
  write(path.join(piDir, `x_${PI_SAME_SECOND}.jsonl`), pi(PI_SAME_SECOND, iso(at(20), 273), iso(at(20) + 900)));
  write(path.join(piDir, `x_${PI_RAN_THEN}.jsonl`), pi(PI_RAN_THEN, iso(at(19) - 432), iso(at(19) + 300)));
  for (const file of files) {
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(file, old, old);
  }
  const active = path.join(claudeDir, `${SESSION_ACTIVE}.jsonl`);
  fs.writeFileSync(active, claude(SESSION_ACTIVE, 'still being written'));
  return [...files, active];
}

async function fixture(): Promise<Fixture> {
  const rig = await memberRig();
  const mycoHome = tempMycoHome();
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-')));
  const home = path.join(base, 'home');
  const root = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const heldHome = process.env.HOME;
  process.env.HOME = home;
  buildTranscripts(home, root);
  const vault = buildVault(path.join(base, 'myco-14'), root, home);
  writeDeploymentMembership({ serverUrl: SERVER, token: rig.token, tokenId: rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome });

  // Live capture already holds one vault session, with a transcript, its own facts, an end and an automatic title,
  // and another whose title an administrator set.
  const sqlite = rig.env.sqlite;
  sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT, PROJECT, Date.now()]);
  const liveStart = (at(33) + 5) * 1000 + 123;
  const liveEnd = liveStart + 60_456;
  for (const [sessionId, branch] of [[SESSION_LIVE, 'live-branch'], [SESSION_ADMIN, 'admin-branch']] as const) {
    const answer = await rig.postEvent({
      eventId: crypto.randomUUID(), sessionId, kind: 'session.start', createdAt: liveStart, channel: 'cli',
      producer: { adapter: 'claude-code', version: '2.0.0' }, payload: { agent: 'claude-code', branch, startedAt: liveStart, originPath: root },
    } as never);
    expect(answer.persisted).toBe(true);
  }
  expect((await rig.postEvent({
    eventId: crypto.randomUUID(), sessionId: SESSION_LIVE, kind: 'session.end', createdAt: liveEnd, channel: 'cli',
    producer: { adapter: 'claude-code', version: '2.0.0' }, payload: { endedAt: liveEnd },
  } as never)).persisted).toBe(true);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, role, head_hash, size, segment_count, first_received_at, last_received_at, token_id)
              VALUES (?, 'tx_00000000000000000000000000000001', ?, ?, 'claude-code', 'primary', NULL, 10, 1, ?, ?, ?)`, [PROJECT, SESSION_LIVE, TEST_MACHINE_ID, Date.now(), Date.now(), rig.tokenId]);
  sqlite.run(`UPDATE sessions SET title = 'Automatic title', titled_at = 1 WHERE project_id = ? AND session_id = ?`, [PROJECT, SESSION_LIVE]);
  sqlite.run(`UPDATE sessions SET title = 'Admin title', titled_at = 1, titled_by = 'mem_admin' WHERE project_id = ? AND session_id = ?`, [PROJECT, SESSION_ADMIN]);

  const tables = ['sessions', 'prompt_batches', 'responses', 'plans', 'spores', 'resolution_events', 'events', 'transcripts', 'blobs', 'session_tombstones'];
  const snapshot = () => ({
    ...Object.fromEntries(tables.map((t) => [t, rig.rows(t)])),
    spores: rig.env.sqlite.query(`SELECT id, status, updated_at FROM spores ORDER BY id`).all(),
    sessions: rig.env.sqlite.query(`SELECT session_id, title, started_at, ended_at, branch FROM sessions ORDER BY session_id`).all(),
  });
  return {
    rig, mycoHome, home, root, vault, liveEnd,
    run: (opts = {}) => runLegacyImport({ sources: [path.dirname(path.dirname(path.dirname(vault)))], serverUrl: SERVER, dryRun: opts.dryRun }, {
      fetch: opts.fetch ?? rig.fetch, mycoHome: opts.mycoHome ?? mycoHome, machineId: TEST_MACHINE_ID, sleep: opts.sleep ?? (async () => {}),
    }),
    cli: async (opts = {}) => {
      const out: string[] = [];
      const ok = await runImportCli(['--legacy', vault, '--days', '3650', '--max', '1000', '--server', SERVER], {
        fetch: opts.fetch ?? rig.fetch, mycoHome: opts.mycoHome ?? mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {}, stdout: (l) => out.push(l), stderr: () => {},
      });
      return { ok, out };
    },
    bind: (home: string) => writeRegistryEntry({
      version: REGISTRY_VERSION, projectId: PROJECT, serverUrl: SERVER, token: rig.token, tokenId: rig.tokenId,
      root, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now(),
    }, { mycoHome: home }),
    snapshot,
    cleanup: () => { if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome; },
  };
}

/** A home signed in to the fixture's Deployment that kept no record of an earlier import. */
function tempMycoHomeWithMembership(f: Fixture): string {
  const mycoHome = tempMycoHome();
  writeDeploymentMembership({ serverUrl: SERVER, token: f.rig.token, tokenId: f.rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome });
  return mycoHome;
}

/** A fetch that counts every answer that was not a plain success, and every event the Deployment answered as refused. */
function watchedFetch(inner: MemberRig['fetch']) {
  const bad: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const res = await inner(req);
    const pathname = new URL(req.url).pathname;
    if (res.status !== 200) bad.push(`${pathname} ${res.status}`);
    else {
      const body = await res.clone().json().catch(() => null) as Record<string, unknown> | null;
      if (body !== null && body.persisted === false) bad.push(`${pathname} refused ${String(body.code)}`);
    }
    return res;
  };
  return { fetch, bad };
}

describe('importing a 1.4 vault', () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });
  afterEach(() => f.cleanup());

  it('lands every session once under its harness id, with one content source, its 1.4 title, and nothing deleted', async () => {
    const watched = watchedFetch(f.rig.fetch);
    const report = await f.run({ fetch: watched.fetch });
    expect(report.refused).toBeUndefined();
    const project = report.projects[0];
    expect(project.endedBy).toBeUndefined();
    expect(project.refusals).toEqual([]);
    expect(project.failures).toEqual([]);
    expect(project.malformed).toEqual(['history res_bad: a supersede that names no successor']);
    expect(project.unmatchedDeletes).toEqual([UNMATCHED_DELETE]);
    expect(project.otherMachines).toEqual({ machine_2: 1 });
    expect(project.sessions.deleted).toBe(2);
    expect(project.deletedButHeld).toEqual([]);
    expect(project.stillWriting).toEqual([SESSION_ACTIVE]);
    expect(watched.bad).toEqual([]);

    const sqlite = f.rig.env.sqlite;
    const sessions = sqlite.query(`SELECT session_id, title, summary, titled_by, branch, started_at, ended_at FROM sessions WHERE project_id = ? ORDER BY session_id`).all(PROJECT) as Array<Record<string, unknown>>;
    // The Codex rollout and the Claude session stored twice are one session each; the Pi file name is its uuid;
    // two hashed Pi ids take the transcript written at their start; the deleted session is absent.
    expect(sessions.map((s) => s.session_id).sort()).toEqual([
      SESSION_ON_DISK, SESSION_PRUNED, SESSION_LIVE, SESSION_ADMIN, SESSION_CURSOR, SESSION_TWICE, CODEX_ROLLOUT, PI_UUID,
      PI_SAME_SECOND, PI_RAN_THEN, 'sess_0000000000000000000000000000dddd',
    ].sort());
    expect(project.aliases.length).toBe(2);
    expect(project.unaliased).toEqual(['sess_0000000000000000000000000000dddd (pi, no transcript)']);
    const byId = new Map(sessions.map((s) => [s.session_id as string, s]));

    // Titles: the vault's, over an automatic one; never over an administrator's; the earlier row's when the later has none.
    expect(byId.get(SESSION_PRUNED)?.title).toBe(`Title of ${SESSION_PRUNED}`);
    expect(byId.get(SESSION_PRUNED)?.summary).toBe(`Summary of ${SESSION_PRUNED}`);
    expect(byId.get(CODEX_ROLLOUT)?.title).toBe('Codex title');
    expect(byId.get(SESSION_LIVE)?.title).toBe('Vault title for live');
    expect(byId.get(SESSION_ADMIN)?.title).toBe('Admin title');
    expect(byId.get(SESSION_TWICE)?.title).toBe('Earlier title');

    // A session live capture held keeps its facts and its end.
    expect(byId.get(SESSION_LIVE)?.branch).toBe('live-branch');
    expect(byId.get(SESSION_LIVE)?.started_at).toBe((at(33) + 5) * 1000 + 123);
    expect(byId.get(SESSION_LIVE)?.ended_at).toBe(f.liveEnd);
    // A session the vault alone recorded takes the vault's facts.
    expect(byId.get(SESSION_PRUNED)?.branch).toBe('feat/x');
    expect(byId.get(SESSION_PRUNED)?.started_at).toBe(at(39) * 1000);

    // Prompts from the vault only where no transcript holds the session.
    const promptTexts = (sessionId: string) =>
      (sqlite.query(`SELECT text FROM prompt_batches WHERE project_id = ? AND session_id = ? ORDER BY created_at`).all(PROJECT, sessionId) as Array<{ text: string | null }>).map((p) => p.text);
    expect(promptTexts(SESSION_PRUNED)).toEqual(['pruned prompt one', 'pruned prompt two']);
    expect(promptTexts(SESSION_TWICE)).toEqual(['earlier prompt']);
    expect(promptTexts(SESSION_ON_DISK).every((t) => t !== 'on disk prompt')).toBe(true);
    expect(promptTexts(SESSION_LIVE)).not.toContain('live prompt from vault');
    expect(promptTexts(CODEX_ROLLOUT)).not.toContain('codex prompt');
    expect(promptTexts(SESSION_CURSOR)).not.toContain('cursor prompt from vault');
    // A session whose transcript is still being written is sent nothing yet.
    expect(promptTexts(SESSION_ACTIVE)).toEqual([]);
    // Neither a retired row nor another machine's row is imported from the vault.
    expect(promptTexts(SESSION_RETIRED)).toEqual([]);
    expect(promptTexts(SESSION_ELSEWHERE)).toEqual([]);

    // Every transcript on disk for a vault session reached the Deployment under that session, under the harness that wrote it.
    const transcripts = sqlite.query(`SELECT session_id, agent FROM transcripts WHERE project_id = ? ORDER BY session_id`).all(PROJECT) as Array<{ session_id: string; agent: string }>;
    expect(transcripts.map((t) => t.session_id).sort()).toEqual([SESSION_ON_DISK, SESSION_LIVE, CODEX_ROLLOUT, PI_UUID, SESSION_CURSOR, PI_SAME_SECOND, PI_RAN_THEN].sort());
    expect(transcripts.find((t) => t.session_id === SESSION_CURSOR)?.agent).toBe('cursor');

    // Spores keep id, status and author agent; history keeps its 1.4 time.
    const spores = sqlite.query(`SELECT id, status, agent_id, session_id, prompt_id FROM spores WHERE project_id = ? ORDER BY id`).all(PROJECT) as Array<Record<string, unknown>>;
    expect(spores.map((s) => [s.id, s.status, s.agent_id])).toEqual([
      ['decision-user', 'active', 'user'], ['gotcha-new', 'active', 'myco-agent'], ['gotcha-of-deleted', 'active', 'myco-agent'],
      ['gotcha-old', 'superseded', 'myco-agent'], ['gotcha-part', 'consolidated', 'myco-agent'], ['wisdom-whole', 'active', 'myco-agent'],
    ]);
    expect(spores.find((s) => s.id === 'gotcha-new')?.session_id).toBe(SESSION_PRUNED);
    expect(spores.find((s) => s.id === 'gotcha-new')?.prompt_id).not.toBeNull();
    expect(spores.find((s) => s.id === 'gotcha-of-deleted')?.session_id).toBeNull();
    const history = sqlite.query(`SELECT id, created_at FROM resolution_events WHERE project_id = ? ORDER BY id`).all(PROJECT);
    expect(history).toEqual([{ id: 'res_1', created_at: at(29) * 1000 }, { id: 'res_2', created_at: at(28) * 1000 }]);

    // Plans: the file plan under the key live capture gives the same file; the deleted session's plan is not sent.
    const plans = sqlite.query(`SELECT plan_key, session_id, status, title FROM plans WHERE project_id = ? ORDER BY title`).all(PROJECT) as Array<Record<string, unknown>>;
    expect(plans.map((p) => p.title)).toEqual(['File plan', 'Key plan']);
    expect(plans[0].plan_key).toBe(planKeyForPath(PROJECT, '.claude/plans/p.md'));
    expect(project.plans).toEqual({ sent: 2, empty: 0, unsent: 1 });

    // No tombstone is written: deleting a session is the owner's alone.
    expect(sqlite.query(`SELECT session_id FROM session_tombstones WHERE project_id = ?`).all(PROJECT)).toEqual([]);

    // Every event this import sent names the fixed producer.
    const producers = sqlite.query(`SELECT DISTINCT producer_adapter, producer_version FROM events WHERE project_id = ? AND channel = 'import' AND kind IN ('session.start', 'session.end', 'prompt', 'response', 'plan')`).all(PROJECT) as Array<Record<string, unknown>>;
    expect(producers).toEqual([{ producer_adapter: LEGACY_PRODUCER.adapter, producer_version: LEGACY_PRODUCER.version }]);
  });

  it('changes nothing when run again, from this machine and from one that kept no record of the first run', async () => {
    await f.run();
    const first = f.snapshot();
    for (const mycoHome of [f.mycoHome, tempMycoHome()]) {
      if (mycoHome !== f.mycoHome) writeDeploymentMembership({ serverUrl: SERVER, token: f.rig.token, tokenId: f.rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome });
      const watched = watchedFetch(f.rig.fetch);
      const again = await f.run({ fetch: watched.fetch, mycoHome });
      const project = again.projects[0];
      expect({ endedBy: project.endedBy, refusals: project.refusals, failures: project.failures }).toEqual({ endedBy: undefined, refusals: [], failures: [] });
      expect(watched.bad).toEqual([]);
      expect(project.spores.duplicate).toBe(6);
      expect(project.lineage.duplicate).toBe(2);
      expect(f.snapshot()).toEqual(first);
    }
  });

  it('leaves a session a person deleted out of every later transcript import, and imports one 1.4 retired', async () => {
    await f.run();
    const bind = (mycoHome: string) => writeRegistryEntry({
      version: REGISTRY_VERSION, projectId: PROJECT, serverUrl: SERVER, token: f.rig.token, tokenId: f.rig.tokenId,
      root: f.root, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now(),
    }, { mycoHome });
    // This machine, with no vault named: its import record leaves it out.
    bind(f.mycoHome);
    await importUntilSettled({ serverUrl: SERVER, windowDays: 3650, maxPerAgent: 1000 }, { fetch: f.rig.fetch, mycoHome: f.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {} });
    expect(f.rig.env.sqlite.query(`SELECT 1 FROM transcripts WHERE session_id = ?`).all(SESSION_DELETED)).toEqual([]);
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ?`).get(SESSION_RETIRED)).toEqual({ n: 1 });
    // A home with no record, importing with the vault named: the vault says so again.
    const fresh = tempMycoHome();
    bind(fresh);
    const out: string[] = [];
    await runImportCli(['--legacy', f.vault, '--days', '3650', '--max', '1000', '--server', SERVER], {
      fetch: f.rig.fetch, mycoHome: fresh, machineId: TEST_MACHINE_ID, sleep: async () => {}, stdout: (l) => out.push(l), stderr: () => {},
    });
    expect(f.rig.env.sqlite.query(`SELECT 1 FROM transcripts WHERE session_id = ?`).all(SESSION_DELETED)).toEqual([]);
    expect(out.join('\n')).toContain(`1 sessions deleted in 1.4 could not be matched to a transcript; delete them from the dashboard if they reappear: ${UNMATCHED_DELETE}`);
  });

  it('keeps a session stored twice when a person deleted one of its rows', async () => {
    const db = openDatabase(f.vault);
    db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'api_delete')`, ['sess_0000000000000000000000000000aaaa', PROJECT, at(29)]);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    await f.run();
    expect(f.rig.env.sqlite.query(`SELECT session_id FROM sessions WHERE session_id = ?`).all(SESSION_TWICE)).toEqual([{ session_id: SESSION_TWICE }]);
    expect(f.rig.env.sqlite.query(`SELECT text FROM prompt_batches WHERE session_id = ?`).all(SESSION_TWICE)).toEqual([]);
  });

  it('never takes a transcript for a session whose prompts came from the vault, on a machine with no record of it', async () => {
    const first = await f.run();
    const claudeDir = path.join(f.home, '.claude', 'projects', `-${rootSlug(f.root)}`);
    const file = path.join(claudeDir, `${SESSION_PRUNED}.jsonl`);
    fs.writeFileSync(file, line({ type: 'user', cwd: f.root, sessionId: SESSION_PRUNED, promptId: UUID(901), message: { content: `pruned prompt one ${'x'.repeat(5000)}` }, timestamp: '2026-08-01T10:00:00Z' }));
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(file, old, old);
    // The vault import on a fresh machine keeps the vault as the source.
    const freshVault = tempMycoHome();
    writeDeploymentMembership({ serverUrl: SERVER, token: f.rig.token, tokenId: f.rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome: freshVault });
    const again = await f.run({ mycoHome: freshVault });
    expect(again.projects[0].sessions.fromVault).toBe(first.projects[0].sessions.fromVault);
    // A transcript import on a fresh machine is refused it.
    const freshTranscripts = tempMycoHome();
    writeRegistryEntry({
      version: REGISTRY_VERSION, projectId: PROJECT, serverUrl: SERVER, token: f.rig.token, tokenId: f.rig.tokenId,
      root: f.root, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now(),
    }, { mycoHome: freshTranscripts });
    const report = await importUntilSettled({ serverUrl: SERVER, windowDays: 3650, maxPerAgent: 1000 }, { fetch: f.rig.fetch, mycoHome: freshTranscripts, machineId: TEST_MACHINE_ID, sleep: async () => {} });
    expect(report.projects[0].agents.find((a) => a.agent === 'claude-code')?.skipped.vault_sourced).toBeGreaterThanOrEqual(1);
    expect(f.rig.env.sqlite.query(`SELECT 1 FROM transcripts WHERE session_id = ?`).all(SESSION_PRUNED)).toEqual([]);
  });

  it('reports a session another machine holds on the Deployment, and never records it as done', async () => {
    f.rig.env.sqlite.run(`UPDATE sessions SET machine_id = 'machine_2' WHERE session_id = ?`, [SESSION_LIVE]);
    const report = await f.run();
    const project = report.projects[0];
    expect(project.refusals.some((r) => r.startsWith(`session ${SESSION_LIVE}: `) && r.includes('identity_mismatch'))).toBe(true);
    expect(project.endedBy).toBeUndefined();
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM spores`).get()).toEqual({ n: 6 });
    const again = await f.run();
    expect(again.projects[0].refusals.some((r) => r.startsWith(`session ${SESSION_LIVE}: `))).toBe(true);
    expect(again.projects[0].sessions.resumed).toBe(10);
  });

  it('refuses a Deployment that cannot say what it holds, before sending any session', async () => {
    const eventsBefore = f.rig.rows('events');
    const olderServer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const res = await f.rig.fetch(input, init);
      if (!new URL(new Request(input, init).url).pathname.endsWith('/import/plan')) return res;
      const body = await res.json() as Record<string, unknown>;
      delete body.sessions;
      return Response.json(body, { headers: res.headers });
    };
    const report = await f.run({ fetch: olderServer });
    expect(report.refused).toContain('update the Deployment');
    expect(f.rig.rows('events')).toBe(eventsBefore);
  });

  it('waits out a rate limit and finishes', async () => {
    let limited = 5;
    const limitedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (limited > 0 && new URL(new Request(input, init).url).pathname === '/events') { limited -= 1; return new Response('slow down', { status: 429 }); }
      return f.rig.fetch(input, init);
    };
    const report = await f.run({ fetch: limitedFetch });
    expect(report.projects[0].endedBy).toBeUndefined();
    expect(report.projects[0].failures).toEqual([]);
    expect(f.rig.rows('spores')).toBe(6);
  });

  it('gives up on a step the Deployment keeps failing, records it, and finishes the rest', async () => {
    let failed = 0;
    const faulty = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/spores/save' && (await req.clone().text()).includes('"gotcha-part"')) { failed += 1; return new Response('boom', { status: 500 }); }
      return f.rig.fetch(req);
    };
    const report = await f.run({ fetch: faulty });
    expect(failed).toBe(SERVER_FAULT_RETRIES + 1);
    expect(report.projects[0].endedBy).toBeUndefined();
    expect(report.projects[0].failures).toEqual(['spore gotcha-part: the Deployment kept failing (500)']);
    expect(f.rig.rows('spores')).toBe(5);
    // A later run sends what failed.
    await f.run();
    expect(f.rig.rows('spores')).toBe(6);
  });

  it('fails a step at once on a status no retry changes, and moves on', async () => {
    let calls = 0;
    const missing = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/spores/save' && (await req.clone().text()).includes('"gotcha-part"')) { calls += 1; return new Response('nope', { status: 404 }); }
      return f.rig.fetch(req);
    };
    const report = await f.run({ fetch: missing });
    expect(calls).toBe(1);
    expect(report.projects[0].failures).toEqual(['spore gotcha-part: the Deployment answered 404']);
    expect(f.rig.rows('spores')).toBe(5);
  });

  it('reports a session deleted in 1.4 that a transcript import already brought, and fails until the owner deletes it', async () => {
    // Joining imports this machine's transcripts before any vault is named.
    f.bind(f.mycoHome);
    await importUntilSettled({ serverUrl: SERVER, windowDays: 3650, maxPerAgent: 1000 }, { fetch: f.rig.fetch, mycoHome: f.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {} });
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ?`).get(SESSION_DELETED)).toEqual({ n: 1 });

    const report = await f.run();
    expect(report.projects[0].deletedButHeld).toEqual([SESSION_DELETED]);
    expect(report.projects[0].sessions.deleted).toBe(1);
    expect(legacyImportComplete(report)).toBe(false);

    const { ok, out } = await f.cli();
    expect(ok).toBe(false);
    const said = out.join('\n');
    expect(said).toContain(`1 sessions deleted in 1.4 are already on the Deployment; delete them from the dashboard: ${SESSION_DELETED}`);
    expect(said).toContain('  1 sessions deleted in 1.4 were left out, from the vault and from your agents\' transcripts');
  });

  it('decides nothing for a session whose transcript is still being written, and brings it on a run after it settles', async () => {
    const first = await f.run();
    expect(first.projects[0].stillWriting).toEqual([SESSION_ACTIVE]);
    expect(legacySessionsToLeaveOut(f.mycoHome, SERVER).has(SESSION_ACTIVE)).toBe(false);
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id = ?`).get(SESSION_ACTIVE)).toEqual({ n: 0 });
    expect(legacyReportLines(first, false).join('\n')).toContain(`1 sessions are still being written; run the import again later to bring them: ${SESSION_ACTIVE}`);

    const active = path.join(f.home, '.claude', 'projects', `-${rootSlug(f.root)}`, `${SESSION_ACTIVE}.jsonl`);
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(active, old, old);
    const again = await f.run();
    expect(again.projects[0].stillWriting).toEqual([]);
    expect(again.projects[0].sessions.transcriptsShipped).toBe(1);
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ?`).get(SESSION_ACTIVE)).toEqual({ n: 1 });
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id = ? AND text = 'active prompt from vault'`).get(SESSION_ACTIVE)).toEqual({ n: 0 });
  });

  it('stops once one step has waited out its limit, and reports the rest as not attempted', async () => {
    let slept = 0;
    let refusedEvents = 0;
    const down = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (new URL(new Request(input, init).url).pathname === '/events') { refusedEvents += 1; return new Response('down', { status: 503 }); }
      return f.rig.fetch(input, init);
    };
    const report = await f.run({ fetch: down, sleep: async (ms) => { slept += ms; } });
    const project = report.projects[0];
    expect(slept).toBeLessThanOrEqual(IMPORT_WAIT_CAP_MS);
    expect(project.endedBy).toBe(UNREACHABLE);
    expect(project.failures).toHaveLength(1);
    expect(project.failures[0]).toContain('nothing after this was attempted');
    expect(project.notAttempted).toEqual({ sessions: 11, spores: 6, lineage: 3 });
    expect(legacyImportComplete(report)).toBe(false);
    expect(legacyReportLines(report, false).join('\n')).toContain('not attempted: 11 sessions, 6 spores, 3 spore history events');
    expect(f.rig.rows('spores')).toBe(0);
    expect(refusedEvents).toBeGreaterThan(1);
  });

  it('exits non-zero on any refusal and on any failure, and zero when neither happened', async () => {
    const cleanHome = tempMycoHomeWithMembership(f);
    f.bind(cleanHome);
    const clean = await f.cli({ mycoHome: cleanHome });
    expect(clean.ok).toBe(true);
    const missing = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/spores/save' && (await req.clone().text()).includes('"gotcha-part"')) return new Response('nope', { status: 404 });
      return f.rig.fetch(req);
    };
    const failingHome = tempMycoHomeWithMembership(f);
    f.bind(failingHome);
    expect((await f.cli({ fetch: missing, mycoHome: failingHome })).ok).toBe(false);
    f.rig.env.sqlite.run(`UPDATE sessions SET machine_id = 'machine_2' WHERE session_id = ?`, [SESSION_LIVE]);
    const refusedHome = tempMycoHomeWithMembership(f);
    f.bind(refusedHome);
    expect((await f.cli({ mycoHome: refusedHome })).ok).toBe(false);

    const report = await f.run({ dryRun: true });
    const base = report.projects[0];
    expect(legacyImportComplete({ ...report, projects: [base] })).toBe(true);
    expect(legacyImportComplete({ ...report, projects: [{ ...base, refusals: ['session x: refused'] }] })).toBe(false);
    expect(legacyImportComplete({ ...report, projects: [{ ...base, failures: ['spore x: the Deployment answered 404'] }] })).toBe(false);
  });

  it('leaves out nothing of a vault one machine captured, whether its rows name no machine or 1.4\'s own', () => {
    const [project] = readLegacyVault(f.vault);
    const local = project.sessions.find((s) => s.id === SESSION_PRUNED)!;
    const unnamed = project.sessions.find((s) => s.id === SESSION_ON_DISK)!;
    const rewritten = { ...project, sessions: project.sessions.map((s) => (s === local ? { ...s, machineId: 'local' } : s === unnamed ? { ...s, machineId: null } : s)) };
    const grouping = groupLegacySessions(rewritten, new Map(), TEST_MACHINE_ID);
    expect(Object.fromEntries(grouping.otherMachines)).toEqual({ machine_2: [SESSION_ELSEWHERE] });
    expect(grouping.groups.map((g) => g.sessionId)).toEqual(expect.arrayContaining([SESSION_PRUNED, SESSION_ON_DISK]));
  });

  it('says what a dry run leaves unmatched and what another machine should run', async () => {
    const dry = legacyReportLines(await f.run({ dryRun: true }), true).join('\n');
    expect(dry).toContain(`  1 sessions deleted in 1.4 could not be matched to a transcript: ${UNMATCHED_DELETE}`);
    const real = legacyReportLines(await f.run(), false).join('\n');
    expect(real).toContain('  1 sessions were captured on machine_2, not this machine; run `myco import --legacy <this vault>` on machine_2 to bring them');
  });

  it('leaves out every session a deletion with no row may name, not only the id 1.4 stored', async () => {
    const uuid = '019ef000-0000-7000-8000-00000000abcd';
    const stored = `2026-06-17T10-00-00-000Z_${uuid}`;
    const db = openDatabase(f.vault);
    db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'api_delete')`, [stored, PROJECT, at(10)]);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const file = path.join(f.home, '.pi', 'agent', 'sessions', `--${rootSlug(f.root)}--`, `${stored}.jsonl`);
    fs.writeFileSync(file, line({ type: 'session', id: uuid, cwd: f.root, timestamp: '2026-06-17T10:00:00.000Z' }) + line({ type: 'message', timestamp: '2026-06-17T10:01:00.000Z', message: { role: 'user', content: `deleted pi ${'z'.repeat(5000)}` } }));
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(file, old, old);

    const [project] = readLegacyVault(f.vault);
    expect(groupLegacySessions(project, new Map(), TEST_MACHINE_ID).deleted.has(uuid)).toBe(true);
    await f.run();
    f.bind(f.mycoHome);
    await importUntilSettled({ serverUrl: SERVER, windowDays: 3650, maxPerAgent: 1000 }, { fetch: f.rig.fetch, mycoHome: f.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {} });
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ?`).get(uuid)).toEqual({ n: 0 });
  });

  it('dates a resolution by the time it names on the import channel alone', async () => {
    await f.run();
    const resolve = (eventId: string, extra: Record<string, unknown>) => f.rig.fetch('https://s/spores/resolve', {
      method: 'POST', headers: f.rig.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ eventId, agentId: 'user', sporeId: 'decision-user', action: 'obsolete', status: 'obsolete', createdAt: 1_000, ...extra }),
    });
    expect((await (await resolve('res_plain', {})).json() as { resolved: boolean }).resolved).toBe(true);
    expect((await (await resolve('res_imported', { channel: 'import' })).json() as { resolved: boolean }).resolved).toBe(true);
    const at = (id: string) => (f.rig.env.sqlite.query(`SELECT created_at FROM resolution_events WHERE id = ?`).get(id) as { created_at: number }).created_at;
    expect(at('res_imported')).toBe(1_000);
    expect(at('res_plain')).toBeGreaterThan(1_000);
  });

  it('resumes from its record without asking again for what finished', async () => {
    await f.run();
    let requests = 0;
    const counting = async (input: string | URL | Request, init?: RequestInit) => { requests += 1; return f.rig.fetch(input, init); };
    const again = await f.run({ fetch: counting });
    expect(again.projects[0].sessions.resumed).toBe(11);
    expect(requests).toBeLessThanOrEqual(2);
  });

  it('stores a title an end carries only from the import channel, and a title-only end moves no end', async () => {
    const sessionId = UUID(50);
    const post = (channel: string, payload: Record<string, unknown>) => f.rig.postEvent({
      eventId: crypto.randomUUID(), sessionId, kind: 'session.end', createdAt: Date.now() - 1000, channel,
      producer: { adapter: 'claude-code', version: '2.0.0' }, payload,
    } as never);
    const endedAt = Date.now() - 5000;
    expect((await post('cli', { endedAt, title: 'From a hook' })).persisted).toBe(true);
    const row = () => (f.rig.env.sqlite.query(`SELECT title, titled_at, ended_at FROM sessions WHERE project_id = ? AND session_id = ?`).get(PROJECT, sessionId) as { title: string | null; titled_at: number | null; ended_at: number | null });
    expect(row().title).toBeNull();
    expect((await post('import', { title: 'From an import' })).persisted).toBe(true);
    expect(row().title).toBe('From an import');
    expect(row().titled_at).not.toBeNull();
    expect(row().ended_at).toBe(endedAt);
  });

  it('counts from the vault alone on a dry run', async () => {
    const before = f.snapshot();
    const report = await f.run({ dryRun: true });
    expect(report.projects[0].sessions.distinct).toBe(12);
    expect(report.projects[0].sessions.deleted).toBe(2);
    expect(report.projects[0].lineage.malformed).toBe(1);
    expect(f.snapshot()).toEqual(before);
  });

  it('leaves a session deleted in 1.4 out of the transcript import too', () => {
    const [project] = readLegacyVault(f.vault);
    const { deleted, unmatchedDeletes } = groupLegacySessions(project, new Map(), TEST_MACHINE_ID);
    expect([...deleted].sort()).toEqual([SESSION_DELETED, UNMATCHED_DELETE].sort());
    expect(unmatchedDeletes).toEqual([UNMATCHED_DELETE]);
    const collected = collectCandidates(['claude-code'], [f.root], TEST_MACHINE_ID, f.mycoHome, Date.now(), { exclude: deleted });
    expect(collected.excluded).toBe(1);
    expect(collected.candidates.map((c) => c.sessionId).sort()).toEqual([SESSION_ON_DISK, SESSION_RETIRED].sort());
  });
});

describe('a vault session takes the id its harness names', () => {
  it('matches what discovery yields for every agent that declares a layout', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-ids-'));
    const env = { ...process.env, HOME: home };
    const id = '019ed19b-85fe-7df9-b24f-f0b69ebad031';
    const declared = BUNDLED_MANIFESTS.filter((m) => m.capture?.transcriptDiscovery !== undefined);
    expect(declared.length).toBeGreaterThan(5);
    const heldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const manifest of declared) {
        const discovery = manifest.capture!.transcriptDiscovery!;
        const root = discovery.roots[0];
        if (root.startsWith('@memberHome')) continue;
        const expanded = root.replace(/^~/, home);
        const relative = discovery.patterns[discovery.patterns.length - 1].split('/').map((segment) => segment.replaceAll('{sessionId}', id).replaceAll('*', 'a1')).join('/');
        const file = path.join(expanded, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}\n');
        const enumerated = enumerateTranscripts(discovery).find((t) => t.filePath === file)?.sessionId;
        expect({ agent: manifest.name, id: sessionIdFromTranscriptPath(discovery, file, env) }).toEqual({ agent: manifest.name, id: enumerated ?? null });
        expect({ agent: manifest.name, id: legacySessionId(manifest.name, 'sess_0123456789abcdef0123456789abcdef', file) }).toEqual({ agent: manifest.name, id });
      }
    } finally {
      if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome;
    }
  });

  it('finds the harness id inside a stored file name, and keeps a stored id no layout shape names', () => {
    const pi = BUNDLED_MANIFESTS.find((m) => m.name === 'pi')!.capture!.transcriptDiscovery!;
    expect(sessionIdFromStoredId(pi, PI_STORED)).toBe(PI_UUID);
    expect(legacySessionId('pi', PI_STORED, null)).toBe(PI_UUID);
    expect(legacySessionId('codex', 'sess_5cd3531754d0313a2b88b7faa4f4b574', null)).toBe('sess_5cd3531754d0313a2b88b7faa4f4b574');
    expect(legacySessionId('antigravity', 'sess_abc', '/home/u/.gemini/tmp/x/chats/session-2026-04-14T13-46-aec3c83f.json')).toBe('sess_abc');
    expect(legacySessionId('opencode', 'ses_f44462c2dffeofpUw0ims0jQxt', null)).toBe('ses_f44462c2dffeofpUw0ims0jQxt');
  });
});

describe('finding a 1.4 vault', () => {
  it('reads a home, a grove directory or a file, and skips empty databases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-files-'));
    const grove = path.join(dir, 'groves', 'grove_a');
    const empty = path.join(dir, 'groves', 'grove_b');
    fs.mkdirSync(grove, { recursive: true });
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(grove, 'myco.db'), 'x');
    fs.writeFileSync(path.join(empty, 'myco.db'), '');
    const file = fs.realpathSync.native(path.join(grove, 'myco.db'));
    expect(legacyVaultFiles(dir).map((f) => fs.realpathSync.native(f))).toEqual([file]);
    expect(legacyVaultFiles(grove).map((f) => fs.realpathSync.native(f))).toEqual([file]);
    expect(legacyVaultFiles(path.join(grove, 'myco.db')).map((f) => fs.realpathSync.native(f))).toEqual([file]);
    expect(legacyVaultFiles(empty)).toEqual([]);
  });
});

describe('pacing an import', () => {
  it('starts no more requests a minute than asked', async () => {
    let clock = 0;
    const started: number[] = [];
    const fetch = paced(async () => { started.push(clock); return new Response('{}'); }, 200, async (ms) => { clock += ms; }, () => clock);
    for (let i = 0; i < 5; i += 1) await fetch('https://s/x');
    expect(started).toEqual([0, 300, 600, 900, 1200]);
  });
});
