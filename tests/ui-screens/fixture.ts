/**
 * The screens fixture: a production-shaped Deployment with no production data.
 *
 * Thirteen projects, as many as a busy owner keeps (six with work in them,
 * one named like a test project, and seven quiet), two members (an admin and a
 * member), two machines with names, five agents, two days of sessions with one
 * still live, spores of every type, plans in every status, Myco's runs (a
 * failed learning run that still saved spores, an index update that failed and
 * then succeeded, a skipped titling run, a map run) and a backup four weeks
 * old.
 *
 * Capture goes through the real `/events` ingest and spores through the real
 * `myco_spores` tool, so the pages read rows written the way production writes
 * them. Only what has no public write path is seeded in SQL: members, machine
 * claims and credentials before the server starts, and runs and the backup
 * after it.
 */
import { Database } from 'bun:sqlite';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { linkStatement } from '@myco-server-worker/auth/identity-link.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL, SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { uuidv5 } from '@myco-server-worker/hash.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface FixtureMember {
  id: string;
  label: string;
  githubSub: string;
  login: string;
  role: 'admin' | 'member';
}

/** Member ids in the shape join mints: `mem_` and the base64url of twelve random bytes. */
export const OWNER: FixtureMember = { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', githubSub: '1000001', login: 'ada', role: 'admin' };
export const READER: FixtureMember = { id: 'mem_Hn5-pC0dJfA9sE_u', label: 'Lin', githubSub: '1000002', login: 'lin', role: 'member' };

/** Two machines, each with a name the way `myco login` records one. */
export const MACHINES = [
  { id: 'studio', member: OWNER, label: 'Ada’s studio Mac' },
  { id: 'buildbox', member: READER, label: 'Lin’s build box' },
] as const;

/**
 * Projects, each with the `proj_<32 hex>` id a named project gets and a short
 * key the seed data below refers to it by.
 */
export const PROJECTS = [
  { key: 'myco', projectId: 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11', name: 'Myco' },
  { key: 'atlas-web', projectId: 'proj_a71a5c0e2b9d4f8e6c3a1b7d5e9f0c22', name: 'Atlas web' },
  { key: 'field-notes', projectId: 'proj_f1e1d0c9b8a7968574635241300f1e33', name: 'Field notes' },
  { key: 'ledger', projectId: 'proj_1ed9e40c5b6a7f8e9d0c1b2a3f4e5d44', name: 'Ledger service' },
  { key: 'infra', projectId: 'proj_2b3c4d5e6f708192a3b4c5d6e7f80955', name: 'Infrastructure' },
  { key: 'sandbox', projectId: 'proj_5a4db0c1d2e3f405162738495a6b7c66', name: 'Test project' },
  { key: 'recipes', projectId: 'proj_7ec1be5a0b1c2d3e4f5a6b7c8d9e0f77', name: 'Recipes' },
  { key: 'homelab', projectId: 'proj_40e1ab0c1d2e3f4a5b6c7d8e9f0a1b88', name: 'Homelab' },
  { key: 'blog', projectId: 'proj_b10960c1d2e3f4a5b6c7d8e9f0a1b299', name: 'Blog' },
  { key: 'docs-site', projectId: 'proj_d0c5a1e0b1c2d3e4f5a6b7c8d9e0f1aa', name: 'Docs site' },
  { key: 'mobile', projectId: 'proj_30b11e0a1b2c3d4e5f6a7b8c9d0e1fbb', name: 'Mobile app' },
  { key: 'pipeline', projectId: 'proj_9a7e11ae0b1c2d3e4f5a6b7c8d9e0fcc', name: 'Data pipeline' },
  { key: 'scratch', projectId: 'proj_5c7a7c40b1c2d3e4f5a6b7c8d9e0f1dd', name: 'Scratch' },
] as const;

type ProjectKey = (typeof PROJECTS)[number]['key'];

/** The project id a seed key stands for. */
export function idOf(key: ProjectKey): string {
  const project = PROJECTS.find((p) => p.key === key);
  if (project === undefined) throw new Error(`no fixture project keyed ${key}`);
  return project.projectId;
}

export const AGENTS = ['claude-code', 'codex', 'cursor', 'opencode', 'pi'] as const;

export const SPORE_TYPES = ['gotcha', 'bug_fix', 'decision', 'discovery', 'trade_off', 'cross-cutting', 'wisdom', 'pattern', 'architecture'] as const;

export const PLAN_STATUSES = ['active', 'in_progress', 'completed', 'abandoned'] as const;

/** One captured session: where it ran, when, and what the agent said it did. */
interface SessionSeed {
  project: ProjectKey;
  agent: (typeof AGENTS)[number];
  machine: (typeof MACHINES)[number]['id'];
  /** Minutes before now the session started. */
  startedAgo: number;
  /** Minutes it ran for; null leaves it live, still receiving events. */
  minutes: number | null;
  title: string;
  summary: string;
  prompts: string[];
}

const SESSIONS: SessionSeed[] = [
  { project: 'myco', agent: 'claude-code', machine: 'studio', startedAgo: 42, minutes: null, title: 'Canopy parity verified across both targets', summary: 'Ran the parity suite against the self-hosted and hosted targets and fixed the one ordering difference in the map reader.', prompts: ['Run the canopy parity scenarios on both targets', 'The hosted target orders ties differently; make the read stable', 'Good, now rerun and confirm'] },
  { project: 'myco', agent: 'codex', machine: 'studio', startedAgo: 3 * 60, minutes: 55, title: 'Search box height made uniform on list pages', summary: 'Moved the Sessions and Knowledge search inputs onto one filter bar so the boxes share a height and left edge.', prompts: ['The search boxes are different heights on each list page', 'Use one filter bar everywhere'] },
  { project: 'atlas-web', agent: 'cursor', machine: 'buildbox', startedAgo: 5 * 60, minutes: 38, title: 'Checkout form validation messages rewritten', summary: 'Replaced the generic validation errors with field-specific messages and added tests for the empty and malformed cases.', prompts: ['Make the checkout errors say which field is wrong', 'Add tests for empty and malformed input'] },
  { project: 'field-notes', agent: 'opencode', machine: 'buildbox', startedAgo: 7 * 60, minutes: 22, title: 'Offline sync conflict resolution sketched', summary: 'Compared last-writer-wins with a per-field merge and wrote up why per-field merge fits notes edited on two phones.', prompts: ['How should we resolve conflicting offline edits?'] },
  { project: 'ledger', agent: 'pi', machine: 'studio', startedAgo: 8 * 60, minutes: 64, title: 'Monthly close report query sped up', summary: 'Added a covering index for the close report and cut the query from 4.2 s to 180 ms on the staging copy.', prompts: ['The monthly close report takes four seconds', 'Try a covering index on entries by account and period'] },
  { project: 'infra', agent: 'claude-code', machine: 'studio', startedAgo: 9 * 60, minutes: 17, title: 'Backup schedule moved to nightly', summary: 'Changed the backup interval from weekly to nightly and confirmed the first run landed in the bucket.', prompts: ['Backups are weekly; make them nightly'] },
  { project: 'myco', agent: 'codex', machine: 'buildbox', startedAgo: 10 * 60, minutes: 41, title: 'Flaky test port collision fixed', summary: 'The test reserved a fixed port that the server’s ephemeral fallback could also pick; it now asks the kernel for one.', prompts: ['This test fails one run in twenty', 'Stop reserving a fixed port'] },
  { project: 'sandbox', agent: 'pi', machine: 'buildbox', startedAgo: 11 * 60, minutes: 6, title: 'Trying the new login flow', summary: 'Signed in on a fresh machine to check the join link opens in a browser.', prompts: ['Try logging in from scratch'] },
  { project: 'atlas-web', agent: 'claude-code', machine: 'studio', startedAgo: 26 * 60, minutes: 70, title: 'Image gallery lazy-loading added', summary: 'Gallery images now load as they scroll into view; the first paint on the product page dropped by 1.1 s.', prompts: ['The product page is slow on phones', 'Lazy-load the gallery images', 'Measure the first paint again'] },
  { project: 'myco', agent: 'cursor', machine: 'studio', startedAgo: 28 * 60, minutes: 33, title: 'Session reading page summary moved first', summary: 'The session page now opens with the summary and keeps the conversation at a readable width.', prompts: ['Put the summary at the top of the session page'] },
  { project: 'field-notes', agent: 'codex', machine: 'buildbox', startedAgo: 30 * 60, minutes: 48, title: 'Markdown export keeps attachments', summary: 'Exported notes now carry their images alongside the markdown file instead of dropping them.', prompts: ['Exported notes lose their images', 'Write the attachments next to the markdown'] },
  { project: 'ledger', agent: 'opencode', machine: 'studio', startedAgo: 33 * 60, minutes: 25, title: 'Currency rounding rule documented', summary: 'Wrote down that amounts round half-even at the ledger boundary and only there.', prompts: ['Where do we round currency amounts?'] },
  { project: 'infra', agent: 'pi', machine: 'buildbox', startedAgo: 36 * 60, minutes: 12, title: 'Certificate renewal alert tuned', summary: 'The renewal alert now fires fourteen days out instead of three.', prompts: ['The cert alert fires too late'] },
  { project: 'myco', agent: 'claude-code', machine: 'studio', startedAgo: 40 * 60, minutes: 95, title: 'Work outcomes counted per task', summary: 'Grouped Myco’s runs by the outcome they produce so the work page can say what was learned rather than list every run.', prompts: ['List runs by what they produced', 'Fold the index upkeep into one line', 'Show the failures with their cause'] },
];

/** Spores, one of every type, each headlined by its one-line form. */
const SPORES: Array<{ project: ProjectKey; session: number; type: (typeof SPORE_TYPES)[number]; line: string; content: string }> = [
  { project: 'myco', session: 0, type: 'gotcha', line: 'Hosted and self-hosted order ties differently; sort the map read by path as well as rank.', content: 'The hosted store returned tied ranks in insertion order and the self-hosted store in rowid order. Adding the path as a second sort key makes both targets agree.' },
  { project: 'myco', session: 6, type: 'bug_fix', line: 'A test that reserves a fixed port races the server’s ephemeral fallback; ask the kernel for port 0.', content: 'The server falls back to an ephemeral port when its preferred one is taken, and the test’s reserved port could be that same number. Binding port 0 removes the race.' },
  { project: 'myco', session: 13, type: 'decision', line: 'Myco’s work page shows outcomes per task, and index upkeep folds into one line.', content: 'Owners want to know what was learned, not how many runs happened. Upkeep runs are thousands a week and belong in Health.' },
  { project: 'ledger', session: 4, type: 'discovery', line: 'The close report scans every entry because no index covers account and period together.', content: 'EXPLAIN showed a full scan of entries. A covering index on (account_id, period, amount) serves the report.' },
  { project: 'field-notes', session: 3, type: 'trade_off', line: 'Per-field merge keeps both edits of a note at the cost of an occasional odd title.', content: 'Last-writer-wins loses a paragraph when two phones edit offline. Per-field merge keeps both, and a title can end up from one device and the body from another.' },
  { project: 'myco', session: 1, type: 'cross-cutting', line: 'Every list page takes its search box from the one filter bar, so heights and edges match.', content: 'The Sessions and Knowledge pages each had their own search input at a different height. One filter bar component fixes it everywhere at once.' },
  { project: 'atlas-web', session: 8, type: 'wisdom', line: 'Measure first paint on a throttled phone profile before and after any image change.', content: 'Desktop numbers hid a 1.1 s regression that only showed on a mid-range phone profile.' },
  { project: 'atlas-web', session: 2, type: 'pattern', line: 'Validation messages name the field and the fix, never just “invalid input”.', content: 'Each checkout field carries its own message saying what is wrong and what a valid value looks like.' },
  { project: 'infra', session: 5, type: 'architecture', line: 'Backups run nightly to object storage and are verified by a restore preview each week.', content: 'The nightly job writes to the bucket; a weekly restore preview proves the newest backup opens.' },
];

const PLANS: Array<{ project: ProjectKey; session: number; status: (typeof PLAN_STATUSES)[number]; title: string; path: string; content: string }> = [
  { project: 'myco', session: 13, status: 'in_progress', title: 'Myco’s work as outcomes', path: 'docs/plans/work-outcomes.md', content: '# Myco’s work as outcomes\n\n- [x] Group runs by task\n- [ ] Fold index upkeep into one line\n- [ ] Show failures with cause and next step' },
  { project: 'myco', session: 1, status: 'active', title: 'One filter bar on every list page', path: 'docs/plans/filter-bar.md', content: '# One filter bar\n\n- [ ] Sessions\n- [ ] Knowledge\n- [ ] Myco’s work' },
  { project: 'ledger', session: 4, status: 'completed', title: 'Speed up the monthly close report', path: 'docs/plans/close-report.md', content: '# Close report\n\n- [x] Find the scan\n- [x] Add the covering index\n- [x] Confirm on staging' },
  { project: 'field-notes', session: 3, status: 'abandoned', title: 'Last-writer-wins offline sync', path: 'docs/plans/lww-sync.md', content: '# Last-writer-wins\n\nDropped in favour of per-field merge.' },
];

export interface SeededFixture {
  projects: Array<{ projectId: string; name: string }>;
  sessions: number;
  liveSessionId: string;
  spores: number;
  plans: number;
  runs: number;
}

/**
 * Members, machine claims and one named credential per machine, written before
 * the server opens the volume. Answers each machine's member token.
 */
export async function seedIdentities(databasePath: string, now: number): Promise<Record<string, string>> {
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  try {
    const db = sqliteRelationalStore(sqlite);
    for (const member of [OWNER, READER]) {
      sqlite.query('INSERT INTO members (id, label, created_at, revoked_at, role) VALUES (?, ?, ?, NULL, ?)').run(member.id, member.label, now - 60 * DAY, member.role);
      await linkStatement(db, member.id, member.githubSub).run();
    }
    const tokens: Record<string, string> = {};
    for (const machine of MACHINES) {
      sqlite.query('INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (?, ?, ?)').run(machine.id, machine.member.id, now - 50 * DAY);
      const issued = await issueMemberToken(db, { memberId: machine.member.id, machineId: machine.id }, now, null, { runtimeLabel: machine.label, runtimeKind: 'cli' });
      tokens[machine.id] = issued.token;
    }
    return tokens;
  } finally {
    sqlite.close();
  }
}

interface SeedContext {
  url: string;
  ownerCookie: string;
  databasePath: string;
  tokens: Record<string, string>;
  now: number;
}

async function expectOk(res: Response, label: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* a non-JSON body is reported below */ }
  if (res.status >= 300) throw new Error(`${label}: ${res.status} ${text.slice(0, 300)}`);
  return body;
}

/** Capture, spores, plans and project names through the server's own routes, then runs and the backup in SQL. */
export async function seedThroughServer(ctx: SeedContext): Promise<SeededFixture> {
  const { url, now } = ctx;
  const ownerHeaders = { cookie: ctx.ownerCookie, origin: url, 'content-type': 'application/json' };

  const memberHeaders = (machine: string, project: ProjectKey) => ({
    authorization: `Bearer ${ctx.tokens[machine]!}`,
    [PROJECT_HEADER]: idOf(project),
    [PROTOCOL_HEADER]: String(SERVER_PROTOCOL),
    'content-type': 'application/json',
  });

  for (const project of PROJECTS) {
    await expectOk(await fetch(`${url}/api/projects`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ projectId: project.projectId, name: project.projectId }) }), `create ${project.projectId}`);
    await expectOk(await fetch(`${url}/api/projects/${project.projectId}`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ name: project.name }) }), `rename ${project.projectId}`);
  }

  const post = async (machine: string, project: ProjectKey, sessionId: string, kind: string, payload: Record<string, unknown>, createdAt: number) => {
    const res = await fetch(`${url}/events`, {
      method: 'POST',
      headers: memberHeaders(machine, project),
      body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt, channel: 'cli', producer: { adapter: 'screens-fixture', version: '1' }, payload }),
    });
    const body = await expectOk(res, `${kind} ${sessionId}`);
    if (body.persisted !== true && body.stored !== true) throw new Error(`${kind} ${sessionId}: refused ${JSON.stringify(body)}`);
  };

  const sessionIds: string[] = [];
  const lastPrompt: string[] = [];
  let liveSessionId = '';
  for (const [index, seed] of SESSIONS.entries()) {
    const sessionId = await uuidv5('screens-session', seed.project, String(index));
    sessionIds.push(sessionId);
    const startedAt = now - seed.startedAgo * MINUTE;
    await post(seed.machine, seed.project, sessionId, 'session.start', { agent: seed.agent, branch: 'main', startedAt }, startedAt);
    const span = seed.minutes === null ? seed.startedAgo - 1 : seed.minutes;
    let promptId = '';
    for (const [i, text] of seed.prompts.entries()) {
      const at = startedAt + Math.round(((i + 0.5) / seed.prompts.length) * span * MINUTE);
      promptId = await uuidv5('screens-prompt', sessionId, String(i));
      await post(seed.machine, seed.project, sessionId, 'prompt', { promptId, text, origin: 'user' }, at);
      await post(seed.machine, seed.project, sessionId, 'response', { responseId: await uuidv5('screens-response', sessionId, String(i)), promptId, text: `Done: ${text.toLowerCase()}.` }, at + 2 * MINUTE);
    }
    lastPrompt.push(promptId);
    if (seed.minutes === null) {
      liveSessionId = sessionId;
    } else {
      const endedAt = startedAt + seed.minutes * MINUTE;
      await post(seed.machine, seed.project, sessionId, 'session.end', { endedAt, title: seed.title, summary: seed.summary }, endedAt);
    }
  }

  const sporeIds: string[] = [];
  for (const spore of SPORES) {
    const session = SESSIONS[spore.session]!;
    if (session.project !== spore.project) throw new Error(`spore ${spore.type} names a session in another project`);
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: memberHeaders(session.machine, spore.project),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_spores', arguments: {
        op: 'save', type: spore.type, content: spore.content, agent_line: spore.line, session_id: sessionIds[spore.session], project: idOf(spore.project),
      } } }),
    });
    const body = await expectOk(res, `spore ${spore.type}`) as { result?: { structuredContent?: { result?: { id?: string; error?: string } } } };
    const saved = body.result?.structuredContent?.result;
    if (!saved?.id) throw new Error(`spore ${spore.type}: ${JSON.stringify(body).slice(0, 300)}`);
    sporeIds.push(saved.id);
  }

  for (const plan of PLANS) {
    const session = SESSIONS[plan.session]!;
    const planKey = await uuidv5('plan', idOf(plan.project), plan.path);
    const at = now - session.startedAgo * MINUTE + 5 * MINUTE;
    await post(session.machine, plan.project, sessionIds[plan.session]!, 'plan', {
      planKey, promptId: lastPrompt[plan.session], title: plan.title, content: plan.content, originPath: plan.path, status: plan.status,
    }, at);
  }

  settleReceiptTimes(ctx.databasePath, liveSessionId, now);
  const runs = seedRuns(ctx.databasePath, now, sporeIds);
  seedBackup(ctx.databasePath, now);

  return {
    projects: PROJECTS.map((p) => ({ projectId: p.projectId, name: p.name })),
    sessions: SESSIONS.length,
    liveSessionId,
    spores: SPORES.length,
    plans: PLANS.length,
    runs,
  };
}

/**
 * The seed posts two days of capture in a few seconds, so every row's receipt
 * time is the seed's own moment. This sets each receipt to the time its event
 * says it happened, so recency reads as it would after two real days, and
 * leaves the live session's last receipt a minute ago.
 */
function settleReceiptTimes(databasePath: string, liveSessionId: string, now: number): void {
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA busy_timeout = 5000');
  try {
    const tables = sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const columns = new Set((sqlite.query(`SELECT name FROM pragma_table_info(?)`).all(name) as Array<{ name: string }>).map((c) => c.name));
      if (columns.has('received_at') && columns.has('created_at')) sqlite.exec(`UPDATE "${name}" SET received_at = created_at`);
    }
    sqlite.exec(`UPDATE sessions SET
      first_received_at = COALESCE((SELECT MIN(e.created_at) FROM events e WHERE e.project_id = sessions.project_id AND e.session_id = sessions.session_id), first_received_at),
      last_received_at = COALESCE((SELECT MAX(e.created_at) FROM events e WHERE e.project_id = sessions.project_id AND e.session_id = sessions.session_id), last_received_at)`);
    sqlite.query('UPDATE sessions SET last_received_at = ? WHERE session_id = ?').run(now - MINUTE, liveSessionId);
  } finally {
    sqlite.close();
  }
}

/**
 * Myco's runs on the `myco` project: a learning run that failed after saving
 * two spores (they carry its id as author), an index update that failed and a
 * later one that succeeded, a skipped titling run, a completed map run and a
 * completed learning run.
 */
function seedRuns(databasePath: string, now: number, sporeIds: string[]): number {
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA foreign_keys = ON');
  try {
    sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'Myco', 'built-in', 1, ?)`).run(now - 60 * DAY);
    const runs: Array<{ id: string; task: string; status: string; startedAgo: number; minutes: number; error?: string; context?: Record<string, unknown>; report?: string }> = [
      { id: 'run_4f1c9a2e7b', task: 'extract-curate', status: 'failed', startedAgo: 2 * 60, minutes: 6, error: 'the run exceeded its turn budget', report: 'Saved 2 spores from 3 sessions before the turn budget ran out.' },
      { id: 'run_8d20b6c1f3', task: 'embedding-reconcile', status: 'failed', startedAgo: 95, minutes: 1, error: 'the embedding provider answered 503' },
      { id: 'run_8d20b6c2a9', task: 'embedding-reconcile', status: 'completed', startedAgo: 80, minutes: 1 },
      { id: 'run_b73e05d4c8', task: 'title-summary', status: 'skipped', startedAgo: 60, minutes: 0, context: { reason: 'no session is waiting for a title' } },
      { id: 'run_c19f7a0e55', task: 'canopy-map', status: 'completed', startedAgo: 20 * 60, minutes: 4, report: 'Mapped 412 files at the latest commit.' },
      { id: 'run_e0a4d2b917', task: 'extract-curate', status: 'completed', startedAgo: 27 * 60, minutes: 9, report: 'Saved 3 spores from 4 sessions.' },
    ];
    for (const run of runs) {
      const startedAt = now - run.startedAgo * MINUTE;
      sqlite.query(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, resumable, error, run_context, tokens_used, estimated_cost_usd)
        VALUES (?, ?, 'myco-agent', ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(
        idOf('myco'), run.id, run.task, run.status, startedAt, startedAt + run.minutes * MINUTE, run.error ?? null,
        run.context ? JSON.stringify(run.context) : null, run.status === 'skipped' ? null : 18_000 + run.minutes * 1_500, run.status === 'skipped' ? null : 0.12 * Math.max(1, run.minutes),
      );
      if (run.report) {
        sqlite.query(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES (?, ?, 'myco-agent', 'summary', ?, ?)`)
          .run(idOf('myco'), run.id, run.report, startedAt + run.minutes * MINUTE);
      }
    }
    const authored = sporeIds.slice(0, 2);
    for (const id of authored) sqlite.query(`UPDATE spores SET author = 'run_4f1c9a2e7b' WHERE project_id = ? AND id = ?`).run(idOf('myco'), id);
    return runs.length;
  } finally {
    sqlite.close();
  }
}

/** A backup four weeks old, so health has an overdue backup to report. */
function seedBackup(databasePath: string, now: number): void {
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA busy_timeout = 5000');
  try {
    const createdAt = now - 28 * DAY;
    sqlite.query(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned) VALUES (?, ?, ?, ?, ?, ?, 'selfhosted', 0)`)
      .run('bk_fixture_old', `backups/${createdAt}.sqlite`, createdAt, 48_213_504, JSON.stringify({ sessions: SESSIONS.length, spores: SPORES.length }), SERVER_SCHEMA_VERSION);
  } finally {
    sqlite.close();
  }
}
