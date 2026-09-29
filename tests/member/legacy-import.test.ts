/**
 * Importing a Myco 1.4 vault into a Deployment, against the real worker.
 *
 * The properties this is judged by:
 *
 *   - every vault session lands once, under the id its harness names, whether
 *     the vault stored that id, a hashed id with the transcript's path, or the
 *     transcript's whole file name;
 *   - its prompts come from exactly one source: the transcript where one is on
 *     disk or already held, the vault only where neither is;
 *   - its 1.4 title and summary land, and never over a title an administrator
 *     set; a session live capture already recorded keeps the facts it was
 *     captured with;
 *   - spores keep their ids, status and history; plans keep the key live
 *     capture gives the same file;
 *   - a session 1.4 deleted is not imported, from the vault or from disk;
 *   - running it again changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  groupLegacySessions, legacySessionId, legacyVaultFiles, readLegacyVault, runLegacyImport, LEGACY_PRODUCER,
} from '@myco/member/legacy-import.js';
import { collectCandidates } from '@myco/member/import.js';
import { planKeyForPath } from '@myco/member/envelope.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { enumerateTranscripts, sessionIdFromStoredId, sessionIdFromTranscriptPath } from '@myco/symbionts/transcript-discovery.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { memberRig, tempMycoHome, TEST_MACHINE_ID, type MemberRig } from './helpers/server.js';

const SERVER = 'https://member-test.invalid';
const PROJECT = 'proj_1';
const DAY_S = 86_400;
const NOW_S = Math.floor(Date.now() / 1000);
const at = (daysAgo: number) => NOW_S - daysAgo * DAY_S;

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SESSION_ON_DISK = UUID(1);
const SESSION_PRUNED = UUID(2);
const CODEX_ROLLOUT = '019dea98-5347-7f62-9d6f-3642db11931e';
const PI_UUID = '019ed19b-85fe-7df9-b24f-f0b69ebad031';
const PI_STORED = `2026-06-16T18-04-51-070Z_${PI_UUID}`;
const SESSION_DELETED = UUID(5);
const SESSION_LIVE = UUID(6);
const SESSION_ADMIN = UUID(7);

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

interface Fixture {
  rig: MemberRig;
  mycoHome: string;
  home: string;
  root: string;
  vault: string;
  run: (opts?: { dryRun?: boolean }) => ReturnType<typeof runLegacyImport>;
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
  const session = (id: string, agent: string, startedDaysAgo: number, extra: Record<string, unknown> = {}) => {
    const row = {
      id, agent, project_root: root, project_id: PROJECT, branch: 'feat/x', started_at: at(startedDaysAgo), ended_at: at(startedDaysAgo) + 600,
      status: 'completed', title: `Title of ${id}`, summary: `Summary of ${id}`, transcript_path: null, created_at: at(startedDaysAgo), ...extra,
    };
    const cols = Object.keys(row);
    db.run(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(row) as never[]);
  };
  const prompt = (id: number, sessionId: string, text: string, response: string | null, startedDaysAgo: number) => {
    db.run(`INSERT INTO prompt_batches (id, project_id, session_id, prompt_number, user_prompt, response_summary, origin, kind, started_at, ended_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'human', 'initial', ?, ?, ?)`,
      [id, PROJECT, sessionId, id, text, response, at(startedDaysAgo), at(startedDaysAgo) + 30, at(startedDaysAgo)]);
  };

  session(SESSION_ON_DISK, 'claude-code', 40, { transcript_path: path.join(home, '.claude', 'projects', `-${rootSlug(root)}`, `${SESSION_ON_DISK}.jsonl`) });
  prompt(1, SESSION_ON_DISK, 'on disk prompt', 'on disk reply', 40);
  session(SESSION_PRUNED, 'claude-code', 39, { transcript_path: path.join(home, '.claude', 'projects', `-${rootSlug(root)}`, `${SESSION_PRUNED}.jsonl`) });
  prompt(2, SESSION_PRUNED, 'pruned prompt one', 'pruned reply one', 39);
  prompt(3, SESSION_PRUNED, 'pruned prompt two', null, 39);
  // One Codex rollout stored twice: a hashed id with the rollout's path, and the rollout id itself, later.
  const rollout = path.join(home, '.codex', 'sessions', '2026', '04', '30', `rollout-2026-04-30T10-00-00-${CODEX_ROLLOUT}.jsonl`);
  session('sess_5cd3531754d0313a2b88b7faa4f4b574', 'codex', 38, { transcript_path: rollout, title: 'Older codex title' });
  session(CODEX_ROLLOUT, 'codex', 37, { transcript_path: rollout, title: 'Codex title' });
  prompt(4, 'sess_5cd3531754d0313a2b88b7faa4f4b574', 'older codex prompt', null, 38);
  prompt(5, CODEX_ROLLOUT, 'codex prompt', 'codex reply', 37);
  session(PI_STORED, 'pi', 36);
  prompt(6, PI_STORED, 'pi prompt', null, 36);
  session(SESSION_DELETED, 'claude-code', 35, { transcript_path: path.join(home, '.claude', 'projects', `-${rootSlug(root)}`, `${SESSION_DELETED}.jsonl`) });
  prompt(7, SESSION_DELETED, 'deleted prompt', null, 35);
  db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'user')`, [SESSION_DELETED, PROJECT, at(34)]);
  session(SESSION_LIVE, 'claude-code', 33, { title: 'Vault title for live', branch: 'vault-branch' });
  prompt(8, SESSION_LIVE, 'live prompt from vault', null, 33);
  session(SESSION_ADMIN, 'claude-code', 32, { title: 'Vault title for admin' });

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
  db.run(`INSERT INTO resolution_events (id, project_id, agent_id, spore_id, action, new_spore_id, reason, created_at) VALUES (?, ?, 'myco-agent', ?, ?, ?, ?, ?)`,
    ['res_1', PROJECT, 'gotcha-old', 'supersede', 'gotcha-new', 'newer', at(29)]);
  db.run(`INSERT INTO resolution_events (id, project_id, agent_id, spore_id, action, new_spore_id, reason, created_at) VALUES (?, ?, 'myco-agent', ?, ?, ?, ?, ?)`,
    ['res_2', PROJECT, 'gotcha-part', 'consolidate', 'wisdom-whole', 'merged', at(28)]);
  db.close();
  return file;
}

/** The transcripts still on disk: the Claude session, the Codex rollout, the Pi session, and the deleted session's. */
function buildTranscripts(home: string, root: string): void {
  const claudeDir = path.join(home, '.claude', 'projects', `-${rootSlug(root)}`);
  fs.mkdirSync(claudeDir, { recursive: true });
  const claude = (id: string, prompt: string) => line({ type: 'user', cwd: root, sessionId: id, promptId: UUID(900), message: { content: `${prompt} ${'x'.repeat(5000)}` }, timestamp: '2026-08-01T10:00:00Z' })
    + line({ type: 'assistant', cwd: root, message: { content: [{ type: 'text', text: 'reply from disk' }] }, timestamp: '2026-08-01T10:00:01Z' });
  fs.writeFileSync(path.join(claudeDir, `${SESSION_ON_DISK}.jsonl`), claude(SESSION_ON_DISK, 'transcript prompt'));
  fs.writeFileSync(path.join(claudeDir, `${SESSION_DELETED}.jsonl`), claude(SESSION_DELETED, 'deleted transcript prompt'));
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '04', '30');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, `rollout-2026-04-30T10-00-00-${CODEX_ROLLOUT}.jsonl`),
    line({ type: 'session_meta', payload: { id: CODEX_ROLLOUT, cwd: root, source: 'cli', originator: 'codex-tui' } }) + line({ type: 'event_msg', payload: { type: 'user_message', message: `codex from disk ${'y'.repeat(5000)}` } }));
  const piDir = path.join(home, '.pi', 'agent', 'sessions', `--${rootSlug(root)}--`);
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, `${PI_STORED}.jsonl`), line({ type: 'session', id: PI_UUID, cwd: root, timestamp: '2026-06-16T18:04:51.070Z' }) + line({ type: 'message', message: { role: 'user', content: `pi from disk ${'z'.repeat(5000)}` } }));
  for (const file of [path.join(claudeDir, `${SESSION_ON_DISK}.jsonl`), path.join(claudeDir, `${SESSION_DELETED}.jsonl`), path.join(codexDir, `rollout-2026-04-30T10-00-00-${CODEX_ROLLOUT}.jsonl`), path.join(piDir, `${PI_STORED}.jsonl`)]) {
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(file, old, old);
  }
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

  // Live capture already holds one vault session, with a transcript, its own facts and an automatic title,
  // and another whose title an administrator set.
  const sqlite = rig.env.sqlite;
  sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT, PROJECT, Date.now()]);
  const liveStart = (at(33) + 5) * 1000 + 123;
  for (const [sessionId, branch] of [[SESSION_LIVE, 'live-branch'], [SESSION_ADMIN, 'admin-branch']] as const) {
    const answer = await rig.postEvent({
      eventId: crypto.randomUUID(), sessionId, kind: 'session.start', createdAt: liveStart, channel: 'cli',
      producer: { adapter: 'claude-code', version: '2.0.0' }, payload: { agent: 'claude-code', branch, startedAt: liveStart, originPath: root },
    } as never);
    expect(answer.persisted).toBe(true);
  }
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, role, head_hash, size, segment_count, first_received_at, last_received_at, token_id)
              VALUES (?, 'tx_00000000000000000000000000000001', ?, ?, 'claude-code', 'primary', NULL, 10, 1, ?, ?, ?)`, [PROJECT, SESSION_LIVE, TEST_MACHINE_ID, Date.now(), Date.now(), rig.tokenId]);
  sqlite.run(`UPDATE sessions SET title = 'Automatic title', titled_at = 1 WHERE project_id = ? AND session_id = ?`, [PROJECT, SESSION_LIVE]);
  sqlite.run(`UPDATE sessions SET title = 'Admin title', titled_at = 1, titled_by = 'mem_admin' WHERE project_id = ? AND session_id = ?`, [PROJECT, SESSION_ADMIN]);

  const tables = ['sessions', 'prompt_batches', 'responses', 'plans', 'spores', 'resolution_events', 'events', 'transcripts', 'blobs'];
  const snapshot = () => Object.fromEntries(tables.map((t) => [t, rig.rows(t)]));
  return {
    rig, mycoHome, home, root, vault,
    run: (opts = {}) => runLegacyImport({ sources: [path.dirname(path.dirname(path.dirname(vault)))], serverUrl: SERVER, ...opts }, {
      fetch: rig.fetch, mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {},
    }),
    snapshot,
    cleanup: () => { if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome; },
  };
}

describe('importing a 1.4 vault', () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });
  afterEach(() => f.cleanup());

  it('lands every session once under its harness id, with one content source, its 1.4 title, and nothing deleted', async () => {
    const report = await f.run();
    expect(report.refused).toBeUndefined();
    const project = report.projects[0];
    expect(project.endedBy).toBeUndefined();
    expect(project.refusals).toEqual([]);

    const sqlite = f.rig.env.sqlite;
    const sessions = sqlite.query(`SELECT session_id, title, summary, titled_by, branch, started_at FROM sessions WHERE project_id = ? ORDER BY session_id`).all(PROJECT) as Array<Record<string, unknown>>;
    const ids = sessions.map((s) => s.session_id);
    // The Codex rollout stored twice is one session; the Pi file name is its uuid; the deleted session is absent.
    expect(ids.sort()).toEqual([SESSION_ON_DISK, SESSION_PRUNED, SESSION_LIVE, SESSION_ADMIN, CODEX_ROLLOUT, PI_UUID].sort());
    const byId = new Map(sessions.map((s) => [s.session_id as string, s]));

    // Titles: the vault's, over an automatic one; never over an administrator's.
    expect(byId.get(SESSION_PRUNED)?.title).toBe(`Title of ${SESSION_PRUNED}`);
    expect(byId.get(SESSION_PRUNED)?.summary).toBe(`Summary of ${SESSION_PRUNED}`);
    expect(byId.get(CODEX_ROLLOUT)?.title).toBe('Codex title');
    expect(byId.get(SESSION_LIVE)?.title).toBe('Vault title for live');
    expect(byId.get(SESSION_ADMIN)?.title).toBe('Admin title');

    // A session live capture held keeps its facts.
    expect(byId.get(SESSION_LIVE)?.branch).toBe('live-branch');
    expect(byId.get(SESSION_LIVE)?.started_at).toBe((at(33) + 5) * 1000 + 123);
    // A session the vault alone recorded takes the vault's facts.
    expect(byId.get(SESSION_PRUNED)?.branch).toBe('feat/x');
    expect(byId.get(SESSION_PRUNED)?.started_at).toBe(at(39) * 1000);

    // Prompts from the vault only where no transcript holds the session.
    const promptTexts = (sessionId: string) =>
      (sqlite.query(`SELECT text FROM prompt_batches WHERE project_id = ? AND session_id = ? ORDER BY created_at`).all(PROJECT, sessionId) as Array<{ text: string | null }>).map((p) => p.text);
    expect(promptTexts(SESSION_PRUNED)).toEqual(['pruned prompt one', 'pruned prompt two']);
    expect(promptTexts(SESSION_ON_DISK).every((t) => t !== 'on disk prompt')).toBe(true);
    expect(promptTexts(SESSION_LIVE)).not.toContain('live prompt from vault');
    expect(promptTexts(CODEX_ROLLOUT)).not.toContain('codex prompt');
    expect(project.sessions.transcriptsShipped).toBe(3);
    expect(project.sessions.fromVault).toBe(2);

    // Every transcript on disk for a vault session reached the Deployment under that session.
    const transcripts = (sqlite.query(`SELECT session_id FROM transcripts WHERE project_id = ? ORDER BY session_id`).all(PROJECT) as Array<{ session_id: string }>).map((t) => t.session_id);
    expect(transcripts.sort()).toEqual([SESSION_ON_DISK, SESSION_LIVE, CODEX_ROLLOUT, PI_UUID].sort());

    // Spores keep id, status and author agent; lineage is recorded.
    const spores = sqlite.query(`SELECT id, status, agent_id, session_id, prompt_id FROM spores WHERE project_id = ? ORDER BY id`).all(PROJECT) as Array<Record<string, unknown>>;
    expect(spores.map((s) => [s.id, s.status, s.agent_id])).toEqual([
      ['decision-user', 'active', 'user'], ['gotcha-new', 'active', 'myco-agent'], ['gotcha-of-deleted', 'active', 'myco-agent'],
      ['gotcha-old', 'superseded', 'myco-agent'], ['gotcha-part', 'consolidated', 'myco-agent'], ['wisdom-whole', 'active', 'myco-agent'],
    ]);
    expect(spores.find((s) => s.id === 'gotcha-new')?.session_id).toBe(SESSION_PRUNED);
    expect(spores.find((s) => s.id === 'gotcha-new')?.prompt_id).not.toBeNull();
    expect(spores.find((s) => s.id === 'gotcha-of-deleted')?.session_id).toBeNull();
    expect(f.rig.rows('resolution_events')).toBe(2);

    // Plans: the file plan under the key live capture gives the same file; the deleted session's plan is not sent.
    const plans = sqlite.query(`SELECT plan_key, session_id, status, title FROM plans WHERE project_id = ? ORDER BY title`).all(PROJECT) as Array<Record<string, unknown>>;
    expect(plans.map((p) => p.title)).toEqual(['File plan', 'Key plan']);
    expect(plans[0].plan_key).toBe(planKeyForPath(PROJECT, '.claude/plans/p.md'));
    expect(plans[0].status).toBe('completed');
    expect(project.plans).toEqual({ sent: 2, empty: 0, unsent: 1 });

    // Every event this import sent names the fixed producer.
    const producers = sqlite.query(`SELECT DISTINCT producer_adapter, producer_version FROM events WHERE project_id = ? AND channel = 'import' AND kind IN ('session.start', 'session.end', 'prompt', 'response', 'plan')`).all(PROJECT) as Array<Record<string, unknown>>;
    expect(producers).toEqual([{ producer_adapter: LEGACY_PRODUCER.adapter, producer_version: LEGACY_PRODUCER.version }]);
  });

  it('changes nothing when run again', async () => {
    await f.run();
    const first = f.snapshot();
    const again = await f.run();
    expect(again.projects[0].refusals).toEqual([]);
    expect(again.projects[0].spores.duplicate).toBe(6);
    expect(f.snapshot()).toEqual(first);
  });

  it('refuses a Deployment that cannot say what it holds, before sending anything', async () => {
    const eventsBefore = f.rig.rows('events');
    const olderServer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const res = await f.rig.fetch(input, init);
      if (!new URL(new Request(input, init).url).pathname.endsWith('/import/plan')) return res;
      const body = await res.json() as Record<string, unknown>;
      delete body.sessions;
      return Response.json(body, { headers: res.headers });
    };
    const report = await runLegacyImport({ sources: [f.vault], serverUrl: SERVER }, { fetch: olderServer, mycoHome: f.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {} });
    expect(report.refused).toContain('update the Deployment');
    expect(f.rig.rows('events')).toBe(eventsBefore);
  });

  it('waits out a rate limit and finishes', async () => {
    let limited = 5;
    const limitedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (limited > 0 && new URL(new Request(input, init).url).pathname === '/events') { limited -= 1; return new Response('slow down', { status: 429 }); }
      return f.rig.fetch(input, init);
    };
    const waits: number[] = [];
    const report = await runLegacyImport({ sources: [f.vault], serverUrl: SERVER }, { fetch: limitedFetch, mycoHome: f.mycoHome, machineId: TEST_MACHINE_ID, sleep: async (ms) => { waits.push(ms); } });
    expect(report.projects[0].endedBy).toBeUndefined();
    expect(waits.length).toBeGreaterThan(0);
    expect(f.rig.rows('spores')).toBe(6);
  });

  it('leaves a session deleted in 1.4 out of the transcript import too', () => {
    const [project] = readLegacyVault(f.vault);
    const { deleted } = groupLegacySessions(project);
    expect([...deleted]).toEqual([SESSION_DELETED]);
    const collected = collectCandidates(['claude-code'], [f.root], TEST_MACHINE_ID, f.mycoHome, Date.now(), { exclude: deleted });
    expect(collected.excluded).toBe(1);
    expect(collected.candidates.map((c) => c.sessionId)).toEqual([SESSION_ON_DISK]);
  });

  it('stores a title an end carries only from the import channel', async () => {
    const sessionId = UUID(50);
    const post = (channel: string, title: string) => f.rig.postEvent({
      eventId: crypto.randomUUID(), sessionId, kind: 'session.end', createdAt: Date.now() - 1000, channel,
      producer: { adapter: 'claude-code', version: '2.0.0' }, payload: { endedAt: Date.now() - 1000, title },
    } as never);
    expect((await post('cli', 'From a hook')).persisted).toBe(true);
    const title = () => (f.rig.env.sqlite.query(`SELECT title, titled_at FROM sessions WHERE project_id = ? AND session_id = ?`).get(PROJECT, sessionId) as { title: string | null; titled_at: number | null });
    expect(title()).toEqual({ title: null, titled_at: null });
    expect((await post('import', 'From an import')).persisted).toBe(true);
    expect(title().title).toBe('From an import');
    expect(title().titled_at).not.toBeNull();
  });

  it('counts from the vault alone on a dry run', async () => {
    const before = f.snapshot();
    const report = await f.run({ dryRun: true });
    expect(report.projects[0].sessions.distinct).toBe(6);
    expect(report.projects[0].sessions.deleted).toBe(1);
    expect(f.snapshot()).toEqual(before);
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
