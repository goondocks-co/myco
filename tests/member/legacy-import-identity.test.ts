import { afterEach, beforeEach, describe, expect, it } from 'bun:test'; import { planKeyForPath } from '@myco/member/envelope.js'; import { LEGACY_PRODUCER } from '@myco/member/legacy-import.js'; import { importUntilSettled } from '@myco/member/import.js'; import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js'; import { run as runImportCli } from '@myco/cli/import.js'; import { TEST_MACHINE_ID, tempMycoHome } from './helpers/server.js';
import { at, CODEX_ROLLOUT, fixture, PI_UUID, PROJECT, SERVER, SESSION_ACTIVE, SESSION_ADMIN, SESSION_CURSOR, SESSION_DELETED, SESSION_ELSEWHERE, SESSION_LIVE, SESSION_ON_DISK, SESSION_PRUNED, SESSION_RETIRED, SESSION_TWICE, UNMATCHED_DELETE, watchedFetch, type Fixture } from './legacy-import-fixture.js';

describe('legacy import harness identity', () => {
  let f: Fixture; beforeEach(async () => { f = await fixture(); }); afterEach(() => f.cleanup());
  it('lands every session once under its harness id, with one content source, its 1.4 title, and nothing deleted', async () => {
    const watched = watchedFetch(f.rig.fetch);
    const report = await f.run({ fetch: watched.fetch });
    expect(report.refused).toBeUndefined();
    const project = report.projects[0];
    expect(project.endedBy).toBeUndefined();
    expect(project.refusals).toEqual([]);
    expect(project.failures).toEqual([]);
    expect(project.causes?.['spore history has a shape the Deployment cannot read; keep the original vault for recovery']).toBe(1);
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
    // Hashed Pi ids with no canonical harness identity keep their stored ids.
    expect(sessions.map((s) => s.session_id).sort()).toEqual([
      SESSION_ON_DISK, SESSION_PRUNED, SESSION_LIVE, SESSION_ADMIN, SESSION_CURSOR, SESSION_TWICE, CODEX_ROLLOUT, PI_UUID,
      'sess_0000000000000000000000000000bbbb', 'sess_0000000000000000000000000000cccc', 'sess_0000000000000000000000000000dddd',
    ].sort());
    expect(project).not.toHaveProperty('aliases');
    expect(project.unaliased).toEqual(['bbbb', 'cccc', 'dddd'].map(suffix => `sess_0000000000000000000000000000${suffix} (pi, no canonical harness id)`));
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
      (sqlite.query(`SELECT preview AS text FROM session_prompts WHERE project_id = ? AND session_id = ? ORDER BY created_at`).all(PROJECT, sessionId) as Array<{ text: string | null }>).map((p) => p.text);
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
    expect(transcripts.map((t) => t.session_id).sort()).toEqual([SESSION_ON_DISK, SESSION_LIVE, CODEX_ROLLOUT, PI_UUID, SESSION_CURSOR].sort());
    expect(transcripts.find((t) => t.session_id === SESSION_CURSOR)?.agent).toBe('cursor');

    // Spores keep id, status and author agent; history keeps its 1.4 time.
    const spores = sqlite.query(`SELECT id, status, agent_id, session_id, prompt_id FROM spores WHERE project_id = ? ORDER BY id`).all(PROJECT) as Array<Record<string, unknown>>;
    expect(spores.map((s) => [s.id, s.status, s.agent_id])).toEqual([
      ['decision-user', 'active', 'user'], ['gotcha-new', 'active', 'myco-agent'], ['gotcha-of-deleted', 'active', 'myco-agent'],
      ['gotcha-old', 'superseded', 'myco-agent'], ['gotcha-part', 'consolidated', 'myco-agent'], ['wisdom-whole', 'active', 'myco-agent'],
    ]);
    expect(spores.find((s) => s.id === 'gotcha-new')?.session_id).toBe(SESSION_PRUNED);
    expect(spores.find((s) => s.id === 'gotcha-new')?.prompt_id).toBeNull();
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
});
