import { expect } from 'bun:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { Database } from 'bun:sqlite';
import { runLegacyImport } from '@myco/member/legacy-import.js'; import { writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION } from '@myco/member/registry.js'; import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { memberRig, tempMycoHome, TEST_MACHINE_ID, type MemberRig } from './helpers/server.js';
import { run as runImportCli } from '@myco/cli/import.js';
import { publishFixture } from '../myco-server/helpers/fixtures.js';

export const SERVER = 'https://member-test.invalid'; export const PROJECT = 'proj_1'; const DAY_S = 86_400;
export const NOW_S = Math.floor(Date.now() / 1000); export const at = (daysAgo: number) => NOW_S - daysAgo * DAY_S; export const iso = (seconds: number, ms = 0) => new Date(seconds * 1000 + ms).toISOString();
export const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const SESSION_ON_DISK = UUID(1); export const SESSION_PRUNED = UUID(2); export const CODEX_ROLLOUT = '019dea98-5347-7f62-9d6f-3642db11931e'; export const PI_UUID = '019ed19b-85fe-7df9-b24f-f0b69ebad031'; export const PI_STORED = `2026-06-16T18-04-51-070Z_${PI_UUID}`;
export const SESSION_DELETED = UUID(5); export const SESSION_LIVE = UUID(6); export const SESSION_ADMIN = UUID(7); export const SESSION_CURSOR = UUID(8); export const SESSION_TWICE = UUID(9); export const SESSION_RETIRED = UUID(10); export const SESSION_ACTIVE = UUID(12); export const SESSION_ELSEWHERE = UUID(11);
export const UNMATCHED_DELETE = 'sess_00000000000000000000000000000eee'; export const PI_SAME_SECOND = '019da14f-4dc1-73c8-845a-b1af6b207dba'; export const PI_RAN_THEN = '019de5b4-cd62-76bf-8430-8f37da948654';

export const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** A 1.4 vault's schema, frozen from the 1.4 `db/schema.ts` at v76: the shape of every vault this import reads. */
const VAULT_SCHEMA = fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8');

/** Open a vault as 1.4 kept one: in WAL mode. */
export function openVault(file: string): Database {
  const db = new Database(file);
  db.run('PRAGMA journal_mode = WAL');
  return db;
}

export interface Fixture {
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

/** A 1.4 vault built to the frozen 1.4 schema, holding one project and every session shape the import meets. */
function buildVault(dir: string, root: string, home: string): string {
  const file = path.join(dir, 'groves', 'grove_test', 'myco.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openVault(file);
  db.exec(VAULT_SCHEMA);
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

  session(SESSION_ON_DISK, 'claude-code', at(40), { transcript_path: claudePath(SESSION_ON_DISK) }); prompt(1, SESSION_ON_DISK, 'on disk prompt', 'on disk reply', at(40)); session(SESSION_PRUNED, 'claude-code', at(39), { transcript_path: claudePath(SESSION_PRUNED) });
  prompt(2, SESSION_PRUNED, 'pruned prompt one', 'pruned reply one', at(39)); prompt(3, SESSION_PRUNED, 'pruned prompt two', null, at(39));
  // One Codex rollout stored twice: a hashed id with the rollout's path, and the rollout id itself, later.
  const rollout = path.join(home, '.codex', 'sessions', '2026', '04', '30', `rollout-2026-04-30T10-00-00-${CODEX_ROLLOUT}.jsonl`);
  session('sess_5cd3531754d0313a2b88b7faa4f4b574', 'codex', at(38), { transcript_path: rollout, title: 'Older codex title' }); session(CODEX_ROLLOUT, 'codex', at(37), { transcript_path: rollout, title: 'Codex title' }); prompt(4, 'sess_5cd3531754d0313a2b88b7faa4f4b574', 'older codex prompt', null, at(38));
  prompt(5, CODEX_ROLLOUT, 'codex prompt', 'codex reply', at(37)); session(PI_STORED, 'pi', at(36)); prompt(6, PI_STORED, 'pi prompt', null, at(36));
  session(SESSION_DELETED, 'claude-code', at(35), { transcript_path: claudePath(SESSION_DELETED) }); prompt(7, SESSION_DELETED, 'deleted prompt', null, at(35));
  db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'api_delete')`, [SESSION_DELETED, PROJECT, at(34)]);
  // 1.4 retired a session for its own reasons: not imported from the vault, and its transcript is still welcome.
  session(SESSION_RETIRED, 'claude-code', at(34), { transcript_path: claudePath(SESSION_RETIRED) }); prompt(20, SESSION_RETIRED, 'retired prompt', null, at(34));
  db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'maintenance_sweep')`, [SESSION_RETIRED, PROJECT, at(34)]);
  // A person deleted a session whose row 1.4 removed, under an id no layout resolves.
  db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'api_delete')`, [UNMATCHED_DELETE, PROJECT, at(34)]);
  // Another machine captured this one.
  session(SESSION_ELSEWHERE, 'claude-code', at(34), { machine_id: 'machine_2' }); prompt(21, SESSION_ELSEWHERE, 'elsewhere prompt', null, at(34)); session(SESSION_LIVE, 'claude-code', at(33), { title: 'Vault title for live', branch: 'vault-branch' });
  prompt(8, SESSION_LIVE, 'live prompt from vault', null, at(33)); session(SESSION_ADMIN, 'claude-code', at(32), { title: 'Vault title for admin' });
  // Recorded as Claude Code, but the transcript it names is Cursor's.
  session(SESSION_CURSOR, 'claude-code', at(31), { transcript_path: path.join(home, '.cursor', 'projects', 'p', 'agent-transcripts', SESSION_CURSOR, `${SESSION_CURSOR}.jsonl`) });
  prompt(9, SESSION_CURSOR, 'cursor prompt from vault', null, at(31));
  // One pruned Claude session stored twice: the earlier row holds the title and the prompts, the later row neither.
  session('sess_0000000000000000000000000000aaaa', 'claude-code', at(30), { transcript_path: claudePath(SESSION_TWICE), title: 'Earlier title', summary: 'Earlier summary' }); session(SESSION_TWICE, 'claude-code', at(30) + 60, { title: null, summary: null }); prompt(10, 'sess_0000000000000000000000000000aaaa', 'earlier prompt', null, at(30));
  // Pi sessions 1.4 stored under a hashed id with no path: one whose transcript starts in the same second,
  // one whose transcript was being written at that time, one with no transcript at all.
  session('sess_0000000000000000000000000000bbbb', 'pi', at(20)); session('sess_0000000000000000000000000000cccc', 'pi', at(19)); session('sess_0000000000000000000000000000dddd', 'pi', at(18)); prompt(11, 'sess_0000000000000000000000000000dddd', 'orphan pi prompt', null, at(18)); session(SESSION_ACTIVE, 'claude-code', at(1), { transcript_path: claudePath(SESSION_ACTIVE) }); prompt(12, SESSION_ACTIVE, 'active prompt from vault', null, at(1));

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
  spore('gotcha-old', 'myco-agent', 'superseded', SESSION_PRUNED, 2); spore('gotcha-new', 'myco-agent', 'active', SESSION_PRUNED, 2); spore('decision-user', 'user', 'active', null, null);
  spore('gotcha-part', 'myco-agent', 'consolidated', CODEX_ROLLOUT, null); spore('wisdom-whole', 'myco-agent', 'active', null, null); spore('gotcha-of-deleted', 'myco-agent', 'active', SESSION_DELETED, 7);
  const resolution = (id: string, sporeId: string, action: string, newSporeId: string | null, daysAgo: number) =>
    db.run(`INSERT INTO resolution_events (id, project_id, agent_id, spore_id, action, new_spore_id, reason, created_at) VALUES (?, ?, 'myco-agent', ?, ?, ?, 'why', ?)`,
      [id, PROJECT, sporeId, action, newSporeId, at(daysAgo)]);
  resolution('res_1', 'gotcha-old', 'supersede', 'gotcha-new', 29); resolution('res_2', 'gotcha-part', 'consolidate', 'wisdom-whole', 28); resolution('res_bad', 'decision-user', 'supersede', null, 27);
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
  write(path.join(claudeDir, `${SESSION_ON_DISK}.jsonl`), claude(SESSION_ON_DISK, 'transcript prompt')); write(path.join(claudeDir, `${SESSION_DELETED}.jsonl`), claude(SESSION_DELETED, 'deleted transcript prompt')); write(path.join(claudeDir, `${SESSION_RETIRED}.jsonl`), claude(SESSION_RETIRED, 'retired transcript prompt'));
  write(path.join(home, '.codex', 'sessions', '2026', '04', '30', `rollout-2026-04-30T10-00-00-${CODEX_ROLLOUT}.jsonl`),
    line({ type: 'session_meta', payload: { id: CODEX_ROLLOUT, cwd: root, source: 'cli', originator: 'codex-tui' } }) + line({ type: 'event_msg', payload: { type: 'user_message', message: `codex from disk ${'y'.repeat(5000)}` } }));
  write(path.join(home, '.cursor', 'projects', 'p', 'agent-transcripts', SESSION_CURSOR, `${SESSION_CURSOR}.jsonl`),
    line({ role: 'user', message: { content: [{ type: 'text', text: `cursor from disk ${'c'.repeat(5000)}` }] } }));
  const piDir = path.join(home, '.pi', 'agent', 'sessions', `--${rootSlug(root)}--`);
  const pi = (id: string, first: string, last: string) =>
    line({ type: 'session', id, cwd: root, timestamp: first }) + line({ type: 'message', timestamp: last, message: { role: 'user', content: `pi from disk ${'z'.repeat(5000)}` } });
  write(path.join(piDir, `${PI_STORED}.jsonl`), pi(PI_UUID, '2026-06-16T18:04:51.070Z', '2026-06-16T18:05:51.070Z')); write(path.join(piDir, `x_${PI_SAME_SECOND}.jsonl`), pi(PI_SAME_SECOND, iso(at(20), 273), iso(at(20) + 900))); write(path.join(piDir, `x_${PI_RAN_THEN}.jsonl`), pi(PI_RAN_THEN, iso(at(19) - 432), iso(at(19) + 300)));
  for (const file of files) {
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(file, old, old);
  }
  const active = path.join(claudeDir, `${SESSION_ACTIVE}.jsonl`);
  fs.writeFileSync(active, claude(SESSION_ACTIVE, 'still being written'));
  return [...files, active];
}

export async function fixture(prebuilt?: { base: string }): Promise<Fixture> {
  const rig = await memberRig();
  const mycoHome = tempMycoHome();
  const base = prebuilt?.base ?? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-legacy-')));
  const home = path.join(base, 'home');
  const root = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const heldHome = process.env.HOME;
  process.env.HOME = home;
  if (prebuilt === undefined) buildTranscripts(home, root);
  const vault = prebuilt === undefined ? buildVault(path.join(base, 'myco-14'), root, home) : path.join(base, 'myco-14', 'groves', 'grove_test', 'myco.db');
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
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, role, head_hash, size, segment_count, first_received_at, last_received_at, token_id, prompt_identity_scheme)
              VALUES (?, 'tx_00000000000000000000000000000001', ?, ?, 'claude-code', 'primary', NULL, 10, 1, ?, ?, ?, 'claude-v1')`, [PROJECT, SESSION_LIVE, TEST_MACHINE_ID, Date.now(), Date.now(), rig.tokenId]);
  sqlite.run(`UPDATE sessions SET title = 'Automatic title', titled_at = 1 WHERE project_id = ? AND session_id = ?`, [PROJECT, SESSION_LIVE]);
  sqlite.run(`UPDATE sessions SET title = 'Admin title', titled_at = 1, titled_by = 'mem_admin' WHERE project_id = ? AND session_id = ?`, [PROJECT, SESSION_ADMIN]);

  const tables = ['sessions', 'session_prompts', 'session_documents', 'plans', 'spores', 'resolution_events', 'events', 'transcripts', 'blobs', 'session_tombstones'];
  const snapshot = () => ({
    ...Object.fromEntries(tables.map((t) => [t, rig.rows(t)])),
    spores: rig.env.sqlite.query(`SELECT id, status, updated_at FROM spores ORDER BY id`).all(),
    sessions: rig.env.sqlite.query(`SELECT session_id, title, started_at, ended_at, branch FROM sessions ORDER BY session_id`).all(),
  });
  return {
    rig, mycoHome, home, root, vault, liveEnd,
    run: async (opts = {}) => {
      const result=await runLegacyImport({ sources: [path.dirname(path.dirname(path.dirname(vault)))], serverUrl: SERVER, dryRun: opts.dryRun }, {
        fetch: opts.fetch ?? rig.fetch, mycoHome: opts.mycoHome ?? mycoHome, machineId: TEST_MACHINE_ID, sleep: opts.sleep ?? (async () => {}),
      });
      if(!opts.dryRun)await publishFixture(rig.env);
      return result;
    },
    cli: async (opts = {}) => {
      const out: string[] = [];
      const ok = await runImportCli(['--legacy', vault, '--days', '3650', '--max', '1000', '--server', SERVER], {
        fetch: opts.fetch ?? rig.fetch, mycoHome: opts.mycoHome ?? mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {}, stdout: (l) => out.push(l), stderr: () => {},
      });
      await publishFixture(rig.env);
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
export function tempMycoHomeWithMembership(f: Fixture): string {
  const mycoHome = tempMycoHome();
  writeDeploymentMembership({ serverUrl: SERVER, token: f.rig.token, tokenId: f.rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome });
  return mycoHome;
}

/** A fetch that counts every answer that was not a plain success, and every event the Deployment answered as refused. */
export function watchedFetch(inner: MemberRig['fetch']) {
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
