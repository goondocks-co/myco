/**
 * The six measures: each computed from rows a Deployment holds, each carrying the
 * sample it stands on.
 *
 * Every assertion here drives the reader against a migrated store with rows
 * written through plain SQL, so a measure is judged on what the tables hold rather
 * than on what a fixture claims. The shape that matters most is the empty one: a
 * measure with no rows answers a null value and a zero sample, which is what lets
 * the surface say there is no sample instead of printing a figure.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { kpiWindow, median, readKpis, KPI_WINDOWS } from '@myco-server-worker/read/kpis.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const PROJECT = 'proj_one';
const OTHER = 'proj_two';

interface Rig {
  db: RelationalStore;
  sqlite: Database;
  session: (id: string, opts?: { project?: string; tokenId?: string; agent?: string | null; at?: number }) => void;
  prompt: (id: string, sessionId: string, opts?: { project?: string; at?: number }) => void;
  call: (id: string, sessionId: string, opts?: { project?: string; at?: number; tool?: string | null; op?: string | null }) => void;
  sporeInjection: (sessionId: string, promptId: string, sporeIds: string[], opts?: { project?: string; at?: number }) => void;
  sessionInjection: (sessionId: string, kind: string, opts?: { project?: string; at?: number }) => void;
  credential: (id: string, opts?: { lineage?: string; startedAt?: number }) => void;
}

function rig(): Rig {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  for (const p of [PROJECT, OTHER]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  sqlite.query(`INSERT INTO members (id, label, created_at, revoked_at) VALUES ('mem_1', 'chris', ?, NULL)`).run(NOW);

  const r: Rig = {
    db: sqliteRelationalStore(sqlite),
    sqlite,
    credential: (id, opts = {}) => {
      sqlite.query(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at, bytes_written)
                    VALUES (?, 'mem_1', ?, ?, ?, ?, ?, ?, 0)`)
        .run(id, `hash_${id}`, `machine_${id}`, NOW, NOW + DAY, opts.lineage ?? id, opts.startedAt ?? NOW);
    },
    session: (id, opts = {}) => {
      const at = opts.at ?? NOW;
      sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                    VALUES (?, ?, 'm1', ?, ?, ?)`)
        .run(opts.project ?? PROJECT, id, opts.tokenId ?? 'cred_1', at, at);
      if (opts.agent !== null) {
        sqlite.query(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, role)
                      VALUES (?, ?, ?, 'm1', ?, 0, 0, ?, ?, ?, 'primary')`)
          .run(opts.project ?? PROJECT, `tr_${id}`, id, opts.agent ?? 'claude-code', at, at, opts.tokenId ?? 'cred_1');
      }
    },
    prompt: (id, sessionId, opts = {}) => {
      const at = opts.at ?? NOW;
      sqlite.query(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, content_hash, created_at, updated_at, token_id, received_at)
                    VALUES (?, ?, ?, ?, 'user', ?, ?, ?, 'cred_1', ?)`)
        .run(opts.project ?? PROJECT, id, sessionId, `ev_${id}`, `hash_${id}`, at, at, at);
    },
    call: (id, sessionId, opts = {}) => {
      const at = opts.at ?? NOW;
      sqlite.query(`INSERT INTO tool_calls (project_id, tool_call_id, session_id, event_id, tool_name, myco_tool, myco_op, success, created_at, token_id, received_at)
                    VALUES (?, ?, ?, ?, 'mcp', ?, ?, 1, ?, 'cred_1', ?)`)
        .run(opts.project ?? PROJECT, id, sessionId, `ev_${id}`, opts.tool === undefined ? 'myco_search' : opts.tool, opts.op ?? null, at, at);
    },
    sporeInjection: (sessionId, promptId, sporeIds, opts = {}) => {
      const at = opts.at ?? NOW;
      sqlite.query(`INSERT INTO spore_injections (project_id, session_id, prompt_id, prompt_hash, spore_ids, plan_ids, created_at)
                    VALUES (?, ?, ?, ?, ?, '[]', ?)`)
        .run(opts.project ?? PROJECT, sessionId, promptId, `ph_${promptId}`, JSON.stringify(sporeIds), at);
    },
    sessionInjection: (sessionId, kind, opts = {}) => {
      sqlite.query(`INSERT INTO session_injections (project_id, session_id, kind, created_at) VALUES (?, ?, ?, ?)`)
        .run(opts.project ?? PROJECT, sessionId, kind, opts.at ?? NOW);
    },
  };
  return r;
}

const all = (db: RelationalStore) => readKpis(db, { windowDays: null, now: NOW });

describe('the measures', () => {
  it('answers every measure with a null value and an empty sample on a Deployment holding nothing', async () => {
    const report = await all(rig().db);
    expect({
      contextPresent: report.contextPresent,
      sporeServeRate: report.sporeServeRate,
      callsPerPrompt: report.callsPerPrompt,
      planReadsPerSession: report.planReadsPerSession,
      firstInjectionMs: report.firstInjectionMs,
      evalPassRate: report.evalPassRate,
      byHarness: report.callsPerPromptByHarness,
    }).toEqual({
      contextPresent: { value: null, sampleSize: 0 },
      sporeServeRate: { value: null, sampleSize: 0 },
      callsPerPrompt: { value: null, sampleSize: 0 },
      planReadsPerSession: { value: null, sampleSize: 0 },
      firstInjectionMs: { value: null, sampleSize: 0 },
      evalPassRate: { value: null, sampleSize: 0 },
      byHarness: [],
    });
  });

  it('credits a session record to one prompt rather than to every prompt after it', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1', { at: NOW + 1 });
    r.prompt('p2', 's1', { at: NOW + 2 });
    r.prompt('p3', 's1', { at: NOW + 3 });
    r.prompt('p4', 's1', { at: NOW + 4 });
    // One session-start record, stamped before every prompt of the session. It
    // reached p1 and nothing else, so a measure that credited all four would
    // saturate to 1.0 on any configured Deployment.
    r.sessionInjection('s1', 'cortex', { at: NOW });
    const report = await all(r.db);
    expect(report.contextPresent).toEqual({ value: 0.25, sampleSize: 4 });
  });

  it('counts a prompt served an observation on its own, beside the one the session record reached', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1', { at: NOW + 1 });
    r.prompt('p2', 's1', { at: NOW + 2 });
    r.prompt('p3', 's1', { at: NOW + 3 });
    r.prompt('p4', 's1', { at: NOW + 4 });
    r.sessionInjection('s1', 'cortex', { at: NOW });
    // p3 receives spores of its own, so two of the four prompts got something.
    r.sporeInjection('s1', 'p3', ['sp1']);
    const report = await all(r.db);
    expect(report.contextPresent).toEqual({ value: 0.5, sampleSize: 4 });
    expect(report.sporeServeRate).toEqual({ value: 0.25, sampleSize: 4 });
  });

  it('does not credit a prompt with a session record stamped after it, and credits the first prompt that follows it', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1', { at: NOW - 10_000 });
    r.prompt('p2', 's1', { at: NOW });
    r.sessionInjection('s1', 'plan-intent-nudge', { at: NOW - 5_000 });
    const report = await all(r.db);
    expect(report.contextPresent).toEqual({ value: 0.5, sampleSize: 2 });
  });

  it('reads a record naming no spore as context served and as a measured zero, not an absent sample', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1');
    r.sporeInjection('s1', 'p1', []);
    const report = await all(r.db);
    // A share of zero over one prompt is a measurement. Only an empty sample has no value.
    expect({ context: report.contextPresent, spores: report.sporeServeRate })
      .toEqual({ context: { value: 1, sampleSize: 1 }, spores: { value: 0, sampleSize: 1 } });
  });

  it('never credits one Project\'s record to another Project\'s prompt', async () => {
    const r = rig();
    r.session('s1');
    r.session('s1', { project: OTHER });
    r.prompt('p1', 's1');
    r.prompt('p1', 's1', { project: OTHER });
    r.sporeInjection('s1', 'p1', ['sp1']);
    const report = await all(r.db);
    expect(report.sporeServeRate).toEqual({ value: 0.5, sampleSize: 2 });
  });

  it('counts Myco calls per prompt and splits them by the agent the session ran under, naming a session with no transcript', async () => {
    const r = rig();
    r.session('s1', { agent: 'claude-code' });
    r.session('s2', { agent: 'codex' });
    r.session('s3', { agent: null });
    r.prompt('p1', 's1');
    r.prompt('p2', 's1');
    r.prompt('p3', 's2');
    r.prompt('p4', 's3');
    r.call('c1', 's1');
    r.call('c2', 's1');
    r.call('c3', 's1');
    r.call('c4', 's2');
    // A tool call that never reached Myco is not a Myco call.
    r.call('c5', 's2', { tool: null });
    const report = await all(r.db);
    expect(report.callsPerPrompt).toEqual({ value: 1, sampleSize: 4 });
    expect(report.callsPerPromptByHarness).toEqual([
      { harness: 'claude-code', value: 1.5, sampleSize: 2, calls: 3 },
      { harness: 'codex', value: 1, sampleSize: 1, calls: 1 },
      { harness: 'unrecorded', value: 0, sampleSize: 1, calls: 0 },
    ]);
  });

  it('gives a harness whose calls landed in the window but whose prompts did not an empty sample rather than leaving it out', async () => {
    const r = rig();
    r.session('recent', { agent: 'claude-code', at: NOW - DAY });
    r.session('old', { agent: 'codex', at: NOW - 60 * DAY });
    r.prompt('p_recent', 'recent', { at: NOW - DAY });
    r.prompt('p_old', 'old', { at: NOW - 60 * DAY });
    r.call('c1', 'recent', { at: NOW - DAY });
    // A codex call inside the window whose prompt sits outside it. The call is
    // counted in the whole, so the split accounts for it rather than dropping it.
    r.call('c2', 'old', { at: NOW - DAY });
    const week = await readKpis(r.db, { windowDays: 7, now: NOW });
    expect(week.callsPerPrompt).toEqual({ value: 2, sampleSize: 1 });
    // The call counts add up to the whole above them: 1 + 1 = 2.
    expect(week.callsPerPromptByHarness).toEqual([
      { harness: 'claude-code', value: 1, sampleSize: 1, calls: 1 },
      { harness: 'codex', value: null, sampleSize: 0, calls: 1 },
    ]);
    expect(week.callsPerPromptByHarness.reduce((n, r) => n + r.calls, 0)).toBe(2);
  });

  it('counts plan reads per session and leaves every plan write out of the count', async () => {
    const r = rig();
    r.session('s1');
    r.session('s2');
    r.call('c1', 's1', { tool: 'myco_plans', op: 'list' });
    r.call('c2', 's1', { tool: 'myco_plans', op: 'get' });
    // The absent op is the tool's own default, which is `list`.
    r.call('c3', 's1', { tool: 'myco_plans', op: null });
    r.call('c4', 's1', { tool: 'myco_plans', op: 'save' });
    // A deletion is a write. An op the allow-list does not name is never a read.
    r.call('c5', 's1', { tool: 'myco_plans', op: 'delete' });
    r.call('c6', 's1', { tool: 'myco_plans', op: 'some_op_added_later' });
    r.call('c7', 's2', { tool: 'myco_search', op: 'search' });
    const report = await all(r.db);
    expect(report.planReadsPerSession).toEqual({ value: 1.5, sampleSize: 2 });
  });

  it('measures the wait to a first served context per credential lineage, taking the middle of the samples', async () => {
    const r = rig();
    // Two credentials of one lineage: the refresh does not read as a second install.
    r.credential('cred_1', { lineage: 'lin_1', startedAt: NOW - 10 * DAY });
    r.credential('cred_1b', { lineage: 'lin_1', startedAt: NOW - 2 * DAY });
    r.credential('cred_2', { lineage: 'lin_2', startedAt: NOW - 5 * DAY });
    r.credential('cred_3', { lineage: 'lin_3', startedAt: NOW - DAY });
    r.session('s1', { tokenId: 'cred_1' });
    r.session('s1b', { tokenId: 'cred_1b' });
    r.session('s2', { tokenId: 'cred_2' });
    r.session('s3', { tokenId: 'cred_3' });
    r.sessionInjection('s1', 'cortex', { at: NOW - 10 * DAY + 60_000 });
    r.sporeInjection('s1b', 'pX', ['sp1'], { at: NOW - DAY });
    r.sessionInjection('s2', 'cortex', { at: NOW - 5 * DAY + 20_000 });
    const report = await all(r.db);
    // lin_1 waited 60s from its lineage start; lin_2 waited 20s; lin_3 has been
    // served nothing and contributes no sample.
    expect(report.firstInjectionMs).toEqual({ value: 40_000, sampleSize: 2 });
  });

  it('counts only rows inside the window a caller asked for', async () => {
    const r = rig();
    r.session('recent', { at: NOW - DAY });
    r.session('old', { at: NOW - 60 * DAY });
    r.prompt('p_recent', 'recent', { at: NOW - DAY });
    r.prompt('p_old', 'old', { at: NOW - 60 * DAY });
    r.sporeInjection('recent', 'p_recent', ['sp1'], { at: NOW - DAY });
    const week = await readKpis(r.db, { windowDays: 7, now: NOW });
    const everything = await all(r.db);
    expect({ week: week.sporeServeRate, all: everything.sporeServeRate, weekSessions: week.planReadsPerSession.sampleSize })
      .toEqual({ week: { value: 1, sampleSize: 1 }, all: { value: 0.5, sampleSize: 2 }, weekSessions: 1 });
    expect({ windowDays: week.windowDays, since: week.since }).toEqual({ windowDays: 7, since: NOW - 7 * DAY });
  });

  it('reports no evaluation sample, the one measure with no feed behind it', async () => {
    const r = rig();
    r.session('s1');
    r.prompt('p1', 's1');
    const report = await all(r.db);
    expect(report.evalPassRate).toEqual({ value: null, sampleSize: 0 });
  });
});

describe('the window a caller may ask for', () => {
  it('admits the offered windows and reads anything else as every row', () => {
    expect(KPI_WINDOWS.map((d) => kpiWindow(String(d)))).toEqual([...KPI_WINDOWS]);
    expect([kpiWindow(null), kpiWindow('all'), kpiWindow('5'), kpiWindow('nonsense'), kpiWindow('-7')])
      .toEqual([null, null, null, null, null]);
  });
});

describe('the middle of a sample', () => {
  it('takes the middle of an odd set and the mean of the two middles of an even one, and has no answer for an empty one', () => {
    expect([median([]), median([5]), median([1, 3, 5]), median([1, 3, 5, 9])]).toEqual([null, 5, 3, 4]);
  });
});
