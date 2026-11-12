/**
 * Importing a Myco 1.4 vault into a Deployment, against the real worker.
 *
 * The properties this is judged by:
 *
 *   - every vault session lands once, under the id its harness names, whether
 *     the vault stored that id, a hashed id with the transcript's path, the
 *     transcript's whole file name, or another harness's path; an unresolved
 *     row keeps its stored id;
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
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import {
  groupLegacySessions, legacySessionId, readLegacyVault, runLegacyImport, UNREACHABLE,
} from '@myco/member/legacy-import.js';
import { legacyVaultFiles } from '@myco/member/home-role.js';
import { collectCandidates, importUntilSettled, paced, IMPORT_WAIT_CAP_MS, SERVER_FAULT_RETRIES } from '@myco/member/import.js';
import { legacySessionsToLeaveOut } from '@myco/member/legacy-ledger.js';
import { writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION } from '@myco/member/registry.js';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { enumerateTranscripts, sessionIdFromStoredId, sessionIdFromTranscriptPath } from '@myco/symbionts/transcript-discovery.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { tempMycoHome, TEST_MACHINE_ID, type MemberRig } from './helpers/server.js';
import { legacyImportComplete, legacyReportLines } from '@myco/cli/import.js';
import { at, CODEX_ROLLOUT, fixture, iso, line, NOW_S, openVault, PI_RAN_THEN, PI_SAME_SECOND, PI_STORED, PI_UUID, PROJECT, SERVER, SESSION_ACTIVE, SESSION_ADMIN, SESSION_CURSOR, SESSION_DELETED, SESSION_ELSEWHERE, SESSION_LIVE, SESSION_ON_DISK, SESSION_PRUNED, SESSION_RETIRED, SESSION_TWICE, tempMycoHomeWithMembership, UNMATCHED_DELETE, UUID, watchedFetch, type Fixture } from './legacy-import-fixture.js';


describe('importing a 1.4 vault', () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });
  afterEach(() => f.cleanup());

  it('keeps two legacy identities starting in the same second separate from the available transcript', async () => {
    const ids = ['a', 'b'].map(c => `sess_${c.repeat(32)}`);
    const harnessId = UUID(100);
    const startedAt = at(45);
    const file = path.join(f.home, '.claude', 'projects', rootSlug(f.root), `${harnessId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, line({ type: 'user', timestamp: iso(startedAt), message: { role: 'user', content: 'one harness session' } }));
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(file, old, old);
    const db = openVault(f.vault);
    try {
      for (const id of ids) db.run(`INSERT INTO sessions (id, project_id, agent, project_root, started_at, ended_at, created_at) VALUES (?, ?, 'claude-code', ?, ?, ?, ?)`, [id, PROJECT, f.root, startedAt, startedAt + 1, startedAt]);
    } finally { db.close(); }
    const report = await f.run();
    expect(report.refused).toBeUndefined();
    expect(report.projects[0].failures).toEqual([]);
    expect(report.projects[0]).not.toHaveProperty('aliases');
    for (const dryRun of [true, false]) {
      const output = legacyReportLines(report, dryRun).join('\n');
      expect(output).toContain(`kept stored id: ${ids[0]} (claude-code, no canonical harness id)`);
      expect(output).not.toContain('matched by time:');
      expect(output).not.toContain('no transcript matched');
    }
    const stored = f.rig.env.sqlite.query('SELECT session_id FROM sessions WHERE project_id = ?').all(PROJECT) as Array<{ session_id: string }>;
    expect(stored.filter(row => ids.includes(row.session_id)).map(row => row.session_id).sort()).toEqual(ids);
    expect(stored.some(row => row.session_id === harnessId)).toBe(false);
  });

  for (const obstruction of ['corrupt', 'directory'] as const) it(`refuses vault and transcript import with ${obstruction} exclusion evidence before sending`, async () => {
    const ledger = new LegacyLedger(f.mycoHome, SERVER, PROJECT);
    ledger.append({ k: 'source', session: 'deleted-session', from: 'deleted' });
    if (obstruction === 'corrupt') fs.appendFileSync(ledger.file, '{broken}\n');
    else { fs.unlinkSync(ledger.file); fs.mkdirSync(ledger.file); }
    f.bind(f.mycoHome);
    let requests = 0;
    const fetch: MemberRig['fetch'] = async () => { requests += 1; throw new Error('unexpected transport'); };
    await expect(f.run({ fetch })).rejects.toThrow('Legacy import ledger');
    await expect(importUntilSettled({ serverUrl: SERVER, windowDays: 3650, maxPerAgent: 1000 }, { fetch, mycoHome: f.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {} })).rejects.toThrow('Legacy import ledger');
    expect(requests).toBe(0);
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


  it('keeps a session stored twice when a person deleted one of its rows', async () => {
    const db = openVault(f.vault);
    db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'api_delete')`, ['sess_0000000000000000000000000000aaaa', PROJECT, at(29)]);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    await f.run();
    expect(f.rig.env.sqlite.query(`SELECT session_id FROM sessions WHERE session_id = ?`).all(SESSION_TWICE)).toEqual([{ session_id: SESSION_TWICE }]);
    expect(f.rig.env.sqlite.query(`SELECT preview AS text FROM session_prompts WHERE session_id = ?`).all(SESSION_TWICE)).toEqual([]);
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
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM session_prompts WHERE session_id = ? AND preview = 'active prompt from vault'`).get(SESSION_ACTIVE)).toEqual({ n: 0 });
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
    const grouping = groupLegacySessions(rewritten, TEST_MACHINE_ID);
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
    const db = openVault(f.vault);
    db.run(`INSERT INTO session_tombstones (session_id, project_id, deleted_at, source) VALUES (?, ?, ?, 'api_delete')`, [stored, PROJECT, at(10)]);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const file = path.join(f.home, '.pi', 'agent', 'sessions', `--${rootSlug(f.root)}--`, `${stored}.jsonl`);
    fs.writeFileSync(file, line({ type: 'session', id: uuid, cwd: f.root, timestamp: '2026-06-17T10:00:00.000Z' }) + line({ type: 'message', timestamp: '2026-06-17T10:01:00.000Z', message: { role: 'user', content: `deleted pi ${'z'.repeat(5000)}` } }));
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(file, old, old);

    const [project] = readLegacyVault(f.vault);
    expect(groupLegacySessions(project, TEST_MACHINE_ID).deleted.has(uuid)).toBe(true);
    await f.run();
    f.bind(f.mycoHome);
    await importUntilSettled({ serverUrl: SERVER, windowDays: 3650, maxPerAgent: 1000 }, { fetch: f.rig.fetch, mycoHome: f.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {} });
    expect(f.rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ?`).get(uuid)).toEqual({ n: 0 });
  });

  it('re-imports a later vault retirement once and converges without retrying a stale write', async () => {
    await f.run();
    expect(f.rig.env.sqlite.query("SELECT status,revision FROM spores WHERE id='decision-user'").get())
      .toEqual({ status: 'active', revision: 0 });
    const vault = new Database(f.vault);
    try {
      vault.run("UPDATE spores SET status='obsolete' WHERE id='decision-user'");
      vault.run("INSERT INTO resolution_events(id,project_id,agent_id,spore_id,action,reason,created_at) VALUES('res_late',?,'user','decision-user','obsolete','retired later',?)", [PROJECT, Date.now() / 1000]);
    } finally { vault.close(); }
    const requests: Record<string, unknown>[] = [];
    const fetch: MemberRig['fetch'] = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/spores/resolve') {
        const body = await request.clone().json() as Record<string, unknown>;
        if (body.eventId === 'res_late') requests.push(body);
      }
      return f.rig.fetch(request);
    };
    await f.run({ fetch });
    expect(requests).toHaveLength(1);
    expect(f.rig.env.sqlite.query("SELECT status,revision FROM spores WHERE id='decision-user'").get())
      .toEqual({ status: 'obsolete', revision: 1 });
    const events = () => f.rig.env.sqlite.query("SELECT id FROM resolution_events WHERE id='res_late'").all();
    expect(events()).toEqual([{ id: 'res_late' }]);
    const third = await f.run();
    expect(third.projects[0].lineage.duplicate).toBe(3);
    expect(events()).toEqual([{ id: 'res_late' }]);
    expect(f.rig.env.sqlite.query("SELECT revision FROM spores WHERE id='decision-user'").get()).toEqual({ revision: 1 });
  });

  it('imports distinct historical events for one terminal source and replays them idempotently', async () => {
    const vault = new Database(f.vault);
    try {
      vault.run("INSERT INTO resolution_events (id,project_id,agent_id,spore_id,action,new_spore_id,reason,session_id,created_at) SELECT 'res_extra',project_id,agent_id,spore_id,action,new_spore_id,reason,session_id,created_at FROM resolution_events WHERE id='res_1'");
    } finally { vault.close(); }
    await f.run();
    const rows = () => f.rig.env.sqlite.query("SELECT id FROM resolution_events WHERE spore_id='gotcha-old' ORDER BY id").all();
    expect(rows()).toEqual([{ id: 'res_1' }, { id: 'res_extra' }]);
    expect(f.rig.env.sqlite.query("SELECT status,revision FROM spores WHERE id='gotcha-old'").get())
      .toEqual({ status: 'superseded', revision: 2 });
    await f.run();
    expect(rows()).toEqual([{ id: 'res_1' }, { id: 'res_extra' }]);
    expect(f.rig.env.sqlite.query("SELECT revision FROM spores WHERE id='gotcha-old'").get()).toEqual({ revision: 2 });
  });

  it('dates a resolution by the time it names on the import channel alone', async () => {
    await f.run();
    const resolve = (eventId: string, extra: Record<string, unknown>) => f.rig.fetch('https://s/spores/resolve', {
      method: 'POST', headers: f.rig.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ eventId, agentId: 'user', sporeId: 'decision-user', action: 'obsolete', status: 'obsolete', reason: 'Retire this fixture', createdAt: 1_000, ...extra }),
    });
    expect((await (await resolve('res_plain', {})).json() as { resolved: boolean }).resolved).toBe(true);
    expect((await (await resolve('res_imported', { channel: 'import', expectStatus: 'obsolete' })).json() as { resolved: boolean }).resolved).toBe(true);
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
    const { deleted, unmatchedDeletes } = groupLegacySessions(project, TEST_MACHINE_ID);
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

import { IMPORT_FAULTS, faultAt, importSnapshot } from './helpers/import-differential.js';
import { LegacyLedger } from '@myco/member/legacy-ledger.js';

/** Linked vault and live-capture sessions, optionally including a transcript-only spore source. */
function narrowDifferentialVault(f: Fixture, sessionOnly = false): void {
  const db = openVault(f.vault);
  db.run('PRAGMA foreign_keys = OFF');
  db.run('DELETE FROM sessions WHERE id NOT IN (?, ?, ?)', [SESSION_PRUNED, SESSION_LIVE, sessionOnly ? CODEX_ROLLOUT : SESSION_LIVE]);
  db.run('DELETE FROM prompt_batches WHERE session_id NOT IN (?, ?)', [SESSION_PRUNED, SESSION_LIVE]);
  db.run("DELETE FROM plans WHERE id <> 'plan_file'");
  db.run("DELETE FROM spores WHERE id NOT IN (?, ?, ?)", ['gotcha-old', 'gotcha-new', sessionOnly ? 'gotcha-part' : 'gotcha-new']);
  db.run("DELETE FROM resolution_events WHERE id <> 'res_1'");
  db.run('DELETE FROM session_tombstones');
  db.close();
}

async function differentialImport(f: Fixture, fetch = f.rig.fetch, signal?: AbortSignal) {
  return runLegacyImport({ sources: [f.vault], serverUrl: SERVER }, {
    fetch, mycoHome: f.mycoHome, machineId: TEST_MACHINE_ID, sleep: async () => {}, signal, maxPasses: 2,
  });
}

describe('vault import fault/resume differential', () => {
  let restoreClock: () => void;
  beforeEach(() => {
    const clock = spyOn(Date, 'now').mockReturnValue(NOW_S * 1000);
    restoreClock = () => clock.mockRestore();
  });
  afterEach(() => restoreClock());

  for (const persistent of [false, true]) for (const kind of IMPORT_FAULTS) {
    it(`${kind}, ${persistent ? 'persistent' : 'single'} at every request: resume equals uninterrupted rows`, async () => {
      const originalHome = process.env.HOME;
      const base = await fixture();
      narrowDifferentialVault(base);
      const basePath = path.dirname(base.root);
      const counter = faultAt(base.rig.fetch, Infinity, kind, false, new AbortController());
      expect(legacyImportComplete(await differentialImport(base, counter.fetch))).toBe(true);
      const baseline = importSnapshot(base.rig.env.sqlite);
      const requests = counter.count();
      base.cleanup();
      try {
        for (let index = 1; index <= requests; index += 1) {
          const f = await fixture({ base: basePath });
          const controller = new AbortController();
          const fault = faultAt(f.rig.fetch, index, kind, persistent, controller);
          try {
            await differentialImport(f, fault.fetch, controller.signal);
            expect(legacyImportComplete(await differentialImport(f)), `${kind} ${persistent} request ${index}: complete`).toBe(true);
            expect(importSnapshot(f.rig.env.sqlite), `${kind} ${persistent} request ${index}`).toEqual(baseline);
          } finally { f.cleanup(); }
        }
      } finally { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; }
    }, 60_000);
  }

  for (const missingTimestamp of [false, true]) it(`repairs an old completed ledger with missing end/links, preserving live capture (missing timestamp: ${missingTimestamp})`, async () => {
    const f = await fixture();
    try {
      narrowDifferentialVault(f, true);
      if (missingTimestamp) {
        const vault = openVault(f.vault);
        vault.run("UPDATE spores SET created_at = 'unknown' WHERE id = 'gotcha-new'");
        vault.close();
      }
      await differentialImport(f);
      const baseline = importSnapshot(f.rig.env.sqlite);
      const db = f.rig.env.sqlite;
      const publicationRevision = () => db.query<{ publication_input_revision: number }, [string]>(
        'SELECT publication_input_revision FROM session_documents WHERE session_id = ?',
      ).get(SESSION_PRUNED)!.publication_input_revision;
      const revision = publicationRevision();
      expect(db.query("SELECT session_id, prompt_id FROM spores WHERE id = 'gotcha-part'").get()).toEqual({ session_id: CODEX_ROLLOUT, prompt_id: null });
      db.run("DELETE FROM events WHERE session_id = ? AND kind = 'session.end' AND channel = 'import'", [SESSION_PRUNED]);
      db.run('UPDATE sessions SET ended_at = NULL WHERE session_id = ?', [SESSION_PRUNED]);
      expect(publicationRevision()).toBe(revision + 1);
      const source = db.query("SELECT * FROM spores WHERE id = 'gotcha-new'").get() as Record<string, unknown>;
      db.run("UPDATE spores SET prompt_id = NULL, session_id = NULL WHERE id IN ('gotcha-old','gotcha-new','gotcha-part')");
      const repair = { id: source.id, agentId: source.agent_id, observationType: source.observation_type, content: source.content,
        sessionId: source.session_id, promptId: source.prompt_id, createdAt: source.created_at };
      const post = (extra: Record<string, unknown>) => f.rig.fetch(SERVER + '/spores/save', {
        method: 'POST', headers: f.rig.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ ...repair, ...extra }),
      });
      await post({});
      await post({ channel: 'import', content: 'different content' });
      await post({ channel: 'import', promptId: 'missing-prompt' });
      expect(db.query("SELECT prompt_id FROM spores WHERE id = 'gotcha-new'").get()).toEqual({ prompt_id: null });
      const ledger = new LegacyLedger(f.mycoHome, SERVER, PROJECT);
      fs.writeFileSync(ledger.file, fs.readFileSync(ledger.file, 'utf8').split('\n').filter((line) => !line.includes('"reconciled"')).join('\n'));
      expect(importSnapshot(db)).not.toEqual(baseline);
      expect(legacyImportComplete(await differentialImport(f))).toBe(true);
      expect(publicationRevision()).toBe(revision + 2);
      const repaired = {
        ...baseline,
        session_documents: baseline.session_documents.map((json) => {
          const row = JSON.parse(json);
          if (row.session_id === SESSION_PRUNED) row.publication_input_revision = revision + 2;
          return JSON.stringify(row);
        }).sort(),
      };
      expect(importSnapshot(db)).toEqual(repaired);
      expect((await differentialImport(f)).projects[0].sessions.resumed).toBe(3);
      expect(importSnapshot(db)).toEqual(repaired);
    } finally { f.cleanup(); }
  });
});

it('groups distinct unmapped refusals without claiming a completed pass stopped', async () => {
  const f = await fixture();
  try {
    const fetch: MemberRig['fetch'] = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/spores/save') {
        const body = await req.clone().json() as { id: string };
        if (body.id === 'gotcha-old') return Response.json({ persisted: false, code: 'project_closed', reason: 'project closed' });
        if (body.id === 'gotcha-new') return Response.json({ persisted: false, code: 'read_only', reason: 'vault is read only' });
      }
      return f.rig.fetch(req);
    };
    const report = await differentialImport(f, fetch);
    expect(report.projects[0]!.endedBy).toBeUndefined();
    const groups = report.projects[0]!.causes!;
    expect(Object.entries(groups).filter(([cause]) => cause.startsWith('project_closed: project closed'))).toHaveLength(1);
    expect(Object.entries(groups).filter(([cause]) => cause.startsWith('read_only: vault is read only'))).toHaveLength(1);
    const lines = legacyReportLines(report, false).join('\n');
    expect(lines).not.toContain('stoppedBy:');
    expect(lines).toContain('1 record or upload: project_closed: project closed');
    expect(lines).toContain('1 record or upload: read_only: vault is read only');
  } finally { f.cleanup(); }
});

it('names a terminal sign-in refusal after a nonterminal spore refusal', async () => {
  const f = await fixture();
  try {
    const fetch: MemberRig['fetch'] = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/spores/save') {
        const body = await req.clone().json() as { id: string };
        if (body.id === 'gotcha-old') return Response.json({ persisted: false, code: 'invalid_field', reason: 'bad content' });
      }
      if (new URL(req.url).pathname === '/spores/resolve') return new Response('sign in', { status: 401, headers: { 'x-myco-protocol': '1' } });
      return f.rig.fetch(req);
    };
    const report = await differentialImport(f, fetch);
    const lines = legacyReportLines(report, false);
    expect(lines.some((l) => l.includes('stoppedBy:') && l.includes('invalid_field'))).toBe(false);
    expect(lines.filter((l) => l.includes('stoppedBy:')).join('\n')).toContain('myco login');
    expect(Object.keys(report.projects[0]!.causes!)).toHaveLength(2);
  } finally { f.cleanup(); }
});

for (const code of ['invalid_field', 'body_cap']) it(`names and counts a refused transcript segment once (${code})`, async () => {
  const f = await fixture();
  try {
    const fetch: MemberRig['fetch'] = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/events') {
        const body = await req.clone().json() as { kind?: string; eventId?: string };
        if (body.kind === 'transcript.segment') return Response.json({ persisted: false, eventId: body.eventId, code, reason: 'invalid segment' });
      }
      return f.rig.fetch(req);
    };
    const report = await differentialImport(f, fetch);
    const p = report.projects[0]!;
    const cause = code === 'body_cap' ? 'a record is too large to send' : 'a record has a value';
    expect(p.stoppedBy).toContain(cause);
    expect(Object.values(p.causes!)).toEqual([1]);
    expect(legacyReportLines(report, false).filter((l) => l.includes('stoppedBy:')).join('\n')).toContain(cause);
    expect(JSON.stringify(p.causes)).not.toContain('rejected');
  } finally { f.cleanup(); }
});

for (const link of ['prompt', 'session']) it(`keeps an existing different ${link} link during repair`, async () => {
  const f = await fixture();
  try {
    await differentialImport(f);
    const db = f.rig.env.sqlite;
    if (link === 'prompt') db.run("UPDATE spores SET prompt_id = 'newer-prompt' WHERE id = 'gotcha-new'");
    else db.run("UPDATE spores SET session_id = ?, prompt_id = NULL WHERE id = 'gotcha-new'", [SESSION_LIVE]);
    const baseline = importSnapshot(db);
    const ledger = new LegacyLedger(f.mycoHome, SERVER, PROJECT);
    fs.writeFileSync(ledger.file, fs.readFileSync(ledger.file, 'utf8').split('\n').filter((l) => !l.includes('"reconciled"')).join('\n'));
    const report = await differentialImport(f);
    expect(legacyImportComplete(report)).toBe(true);
    expect(importSnapshot(db)).toEqual(baseline);
    expect(report.projects[0]!.spores.kept ?? 0).toBe(link === 'session' ? 1 : 0);
  } finally { f.cleanup(); }
});

it('keeps another member’s spore once and completes subsequent imports', async () => {
  const f = await fixture();
  try {
    await differentialImport(f);
    const db = f.rig.env.sqlite;
    const other = await f.rig.otherMachine();
    const source = db.query("SELECT agent_id FROM spores WHERE id = 'gotcha-new'").get() as { agent_id: string };
    db.run("DELETE FROM spores WHERE id = 'gotcha-new'");
    const saved = await f.rig.fetch(SERVER + '/spores/save', {
      method: 'POST', headers: f.rig.headers({ authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }),
      body: JSON.stringify({ id: 'gotcha-new', agentId: source.agent_id, observationType: 'gotcha', content: 'another member’s observation', agentLine: 'When using this fixture, retain its evidence.', sessionId: null }),
    });
    expect((await saved.json() as { persisted: boolean }).persisted).toBe(true);
    const ledger = new LegacyLedger(f.mycoHome, SERVER, PROJECT);
    fs.writeFileSync(ledger.file, fs.readFileSync(ledger.file, 'utf8').split('\n').filter((l) => !l.includes('"reconciled"')).join('\n'));
    const held = db.query("SELECT * FROM spores WHERE id = 'gotcha-new'").get();
    const report = await differentialImport(f);
    expect(legacyImportComplete(report)).toBe(true);
    expect(report.projects[0]!.spores.kept).toBe(1);
    expect(legacyReportLines(report, false).join('\n')).toContain('1 kept with existing source links');
    const again = await differentialImport(f);
    expect(legacyImportComplete(again)).toBe(true);
    expect(again.projects[0]!.spores.kept ?? 0).toBe(0);
    expect(db.query("SELECT * FROM spores WHERE id = 'gotcha-new'").get()).toEqual(held);
  } finally { f.cleanup(); }
});

it('imports for the first time when an older Deployment omits opt-in ownership', async () => {
  const f = await fixture();
  try {
    let probes = 0;
    const fetch: MemberRig['fetch'] = async (input, init) => {
      const req = new Request(input, init);
      const response = await f.rig.fetch(req);
      if (new URL(req.url).pathname !== '/import/plan') return response;
      const body = await response.json() as { sessions?: Record<string, unknown> };
      if (body.sessions !== undefined) { delete body.sessions.legacyOwned; probes += 1; }
      return Response.json(body, { status: response.status, headers: response.headers });
    };
    const report = await differentialImport(f, fetch);
    expect(legacyImportComplete(report)).toBe(true);
    expect(report.refused).toBeUndefined();
    expect(probes).toBeGreaterThan(0);
    expect(report.projects[0]!.sessions.fromVault).toBeGreaterThan(0);
    expect(f.rig.env.sqlite.query('SELECT ended_at FROM sessions WHERE session_id = ?').get(SESSION_LIVE)).toEqual({ ended_at: f.liveEnd });
  } finally { f.cleanup(); }
});
