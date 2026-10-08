import { legacyWorker } from './helpers/worker-principal.js';
import { runRouteFixture } from './helpers/run-routes.js';
/**
 * Every free-text field a worker, a harness or an agent supplies to a run, judged by the adversarial secret corpus on
 * the Deployment that stores it: a worker's error (`/worker/end`) and a caller's error on the run routes
 * (`/runs/update`) are kept as a coded reason alone; a report's summary and details and its audit's
 * steps, reasoning and failures, on the run's own tool and on the run route alike, are agent prose — a command quoted
 * in a code fence, a here-document or inline code keeps none of its secrets, and no key-shaped value survives at all.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, endLeasedRun, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { TITLING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { memberHeaders, memberPost, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { OWNER_ENV } from './helpers/owner.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import {
  AWS_KEY_ID, AWS_SECRET, BARE_JWT, BASE64_SECRET, CORPUS, FREE_TEXT, GITHUB_PAT, GITLAB_PAT, OPENAI_KEY, SLACK_BOT, STRIPE_LIVE, UUID_KEY, type Leak,
  PROSE,
} from '../helpers/secret-corpus.ts';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://s';
const AGENT = 'agent_1';
const KEYS: readonly string[] = [STRIPE_LIVE, OPENAI_KEY, GITHUB_PAT, SLACK_BOT, GITLAB_PAT, AWS_KEY_ID, AWS_SECRET, BARE_JWT, BASE64_SECRET, UUID_KEY];
const KEY_LEAKS: readonly Leak[] = KEYS.map((key) => ({ name: `the key ${key.slice(0, 4)}…`, command: key, secrets: [key, key.slice(0, 12), key.slice(-12)] }));

/** Every leak's secrets found in what is stored. */
const leaked = (leaks: readonly Leak[], stored: string): string[] =>
  leaks.flatMap((leak) => leak.secrets.filter((secret) => stored.includes(secret)).map((secret) => `${leak.name}: ${secret}`));

/** The corpus as an agent quotes it in prose: in a code fence, a here-document, inline code, and every key as it stands. */
const QUOTED = (leaks: readonly Leak[]): string => leaks.map((leak, i) => [
  `Step ${i}: I ran:\n\`\`\`sh\n${leak.command}\n\`\`\``,
  `then wrote it with cat > out.env <<'EOF'\n${leak.command}\nEOF`,
  `and ran \`${leak.command}\` again.`,
].join('\n')).join('\n') + `\nThe keys were ${KEYS.join(', ')}.`;

/** What a harness or a worker might send as a run's error: its words, its stderr, every secret of the corpus. */
const SAID = [...CORPUS, ...FREE_TEXT, ...KEY_LEAKS].map((leak) => leak.command).join('\n');
const ALL: readonly Leak[] = [...CORPUS, ...FREE_TEXT, ...KEY_LEAKS];

const routes = () => runRouteFixture(AGENT);

/** A titling run claimed by a worker, and the run's own tool to report through. */
async function claimedRun() {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'a worker');
  const workerToken = (await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId;
  e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [NOW - 10_000, NOW, NOW - 10_000, NOW]);
  e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's1', 'p1', 'e1', 'add a retry to the runner', 'user', 'h1', ?, ?, 'tok_1', ?)`, [NOW - 5000, NOW - 5000, NOW - 5000]);
  expect((await titleSession(e.serverEnv, { projectId: 'proj_1', sessionId: 's1', now: NOW + 1, origin: ORIGIN })).outcome).toBe('queued');
  const claimed = await claimNextRun(e.serverEnv, { principal: legacyWorker(workerToken, 'm1'), harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now: NOW + 2 });
  if (!claimed.claimed) throw new Error('the titling run was not claimed');
  const report = async (input: Record<string, unknown>) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: 'POST', headers: memberHeaders(claimed.run.runToken, { [PROJECT_HEADER]: 'proj_1' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run', arguments: { op: 'report', ...input } } }),
    }), e.env);
    expect(res.status).toBe(200);
  };
  const end = (error: string) => endLeasedRun(e.serverEnv, { principal: legacyWorker(workerToken, 'm1'), now: NOW + 9 }, { projectId: 'proj_1', runId: claimed.run.id, status: 'failed', error });
  const stored = (): string => JSON.stringify([
    e.sqlite.query('SELECT error, error_code FROM agent_runs WHERE id = ?').get(claimed.run.id),
    e.sqlite.query('SELECT summary, details, audit FROM agent_reports WHERE run_id = ?').all(claimed.run.id),
  ]);
  return { e, run: claimed.run, report, end, stored };
}

describe('a worker\'s error, on the Deployment that stores it', () => {
  it('keeps no word a harness or a worker said, and records the coded reason a reader acts on', async () => {
    for (const [error, kept, code] of [
      [`the harness stopped: error (${SAID})`, 'the harness stopped: error (harness_error)', 'agent_failed'],
      [SAID, 'the worker reported a failure (harness_error)', 'agent_failed'],
      [`the harness stopped: error (authentication_failed: ${SAID})`, 'the harness stopped: error (login_missing)', 'agent_not_signed_in'],
      ['the harness stopped: error (rate_limited; exit code 1)', 'the harness stopped: error (rate_limited; exit code 1)', 'agent_rate_limited'],
      ['the harness stopped: error (crashed; exit code 137; signal SIGKILL)', 'the harness stopped: error (crashed; exit code 137; signal SIGKILL)', 'agent_crashed'],
      ['the run outlived its budget of 300s', 'the run outlived its budget of 300s', 'agent_timed_out'],
      ['the harness stopped: refusal', 'the harness stopped: refusal', 'agent_model_refused'],
    ] as const) {
      const r = await claimedRun();
      try {
        expect(await r.end(error)).toMatchObject({ ended: true });
        expect(r.e.sqlite.query('SELECT error, error_code AS code FROM agent_runs WHERE id = ?').get(r.run.id)).toEqual({ error: kept, code });
        expect(leaked(ALL, r.stored())).toEqual([]);
      } finally { r.e.sqlite.close(); }
    }
  });
});

describe('a caller\'s error on the run routes', () => {
  it('is kept as a coded reason alone, through an update and a recorded failure alike', async () => {
    const { post, sqlite } = await routes();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'container-smoke', capability: 'cortex' });
    await post('/runs/claim', { id: 'r2', agentId: AGENT, task: 'container-smoke', capability: 'cortex' });
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'failed', completed_at: 50, error: SAID } })).toMatchObject({ applied: true });
    expect(await post('/runs/update', { runId: 'r2', update: { error: SAID } })).toMatchObject({ applied: true });
    const rows = sqlite.query(`SELECT id, error FROM agent_runs WHERE id IN ('r1', 'r2') ORDER BY id`).all() as Array<{ id: string; error: string }>;
    expect(rows.map((row) => row.error)).toEqual(Array(2).fill('the worker reported a failure (harness_error)'));
    expect(leaked(ALL, JSON.stringify(rows))).toEqual([]);
  });
});

describe('every text field the run routes still take', () => {
  const NAMES = [...CORPUS, ...KEY_LEAKS];

  it('refuses a claim naming anything but an identifier, and keeps a claim\'s context as a structured record', async () => {
    const { post, sqlite } = await routes();
    let seq = 0;
    for (const leak of NAMES) {
      for (const field of ['id', 'agentId', 'task', 'harness', 'provider', 'model'] as const) {
        const claim = { id: `r_${seq += 1}`, agentId: AGENT, task: 'container-smoke', capability: 'cortex', [field]: leak.command };
        // A model is named by the Deployment's own configuration, so it is held to the identifier shape alone.
        if (field === 'model' && /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]*$/.test(leak.command)) continue;
        // A run's id is minted as a UUID, which is the one key shape it may hold.
        if (field === 'id' && leak.command === UUID_KEY) continue;
        expect({ field, leak: leak.name, persisted: (await post('/runs/claim', claim)).persisted }).toEqual({ field, leak: leak.name, persisted: false });
      }
      expect(await post('/runs/claim', { id: `r_${seq += 1}`, agentId: AGENT, task: 'container-smoke', capability: 'cortex', runContext: JSON.stringify({ note: leak.command, nested: { key: leak.command, list: [leak.command] } }) })).toMatchObject({ claimed: true });
    }
    expect(leaked(NAMES, JSON.stringify(sqlite.query("SELECT id, agent_id, task, harness, provider, model, run_context FROM agent_runs WHERE status = 'running'").all()))).toEqual([]);
  });

  it('keeps an update\'s usage and cost data as structured records and its cost source as a name, never as sent', async () => {
    const { post, sqlite } = await routes();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'container-smoke', capability: 'cortex' });
    for (const leak of [...NAMES, ...PROSE]) {
      const record = JSON.stringify({ model: leak.command, message: leak.command, breakdown: [{ note: leak.command }], [leak.command.slice(0, 20)]: 1 });
      expect(await post('/runs/update', { runId: 'r1', update: { usage_data: record, cost_data: record, tokens_used: 1 } })).toMatchObject({ applied: true });
      const source = await post('/runs/update', { runId: 'r1', update: { cost_source: leak.command } });
      expect({ leak: leak.name, refused: source.persisted === false || leak.command === 'actual' }).toEqual({ leak: leak.name, refused: true });
    }
    expect(leaked([...NAMES, ...PROSE], JSON.stringify(sqlite.query(`SELECT usage_data, cost_data, cost_source FROM agent_runs WHERE id = 'r1'`).all()))).toEqual([]);
  });

  it('refuses a report naming its agent or its action by anything but a name', async () => {
    const { post, sqlite } = await routes();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'container-smoke', capability: 'cortex' });
    for (const leak of NAMES) {
      expect(await post('/runs/report', { runId: 'r1', agentId: leak.command, action: 'container-smoke', summary: 's' })).toMatchObject({ persisted: false });
      expect(await post('/runs/report', { runId: 'r1', agentId: AGENT, action: leak.command, summary: 's' })).toMatchObject({ persisted: false });
    }
    expect(sqlite.query(`SELECT COUNT(*) c FROM agent_reports`).get()).toEqual({ c: 0 });
  });

  it('keeps no secret of the prose corpus in a report or its audit, on the run\'s own tool', async () => {
    const r = await claimedRun();
    try {
      for (const leak of PROSE) {
        await r.report({ action: TITLING_REPORT_ACTION, summary: leak.command, details: `Notes:\n${leak.command}\nDone.`, audit: { ...RUN_AUDIT, steps: [leak.command], reasoning: leak.command, failures: [{ what: leak.command, recovery: leak.command }] } });
      }
      const rows = r.e.sqlite.query('SELECT summary, details, audit FROM agent_reports WHERE run_id = ? ORDER BY id').all(r.run.id) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(PROSE.length);
      expect(rows.flatMap((row, i) => leaked([PROSE[i]!], JSON.stringify(row)))).toEqual([]);
      rows.forEach((row, i) => {
        if (!PROSE[i]!.command.startsWith('Read the policy.\n')) return;
        const stored = JSON.stringify(row);
        expect(stored.match(/Read the policy\./g)).toHaveLength(6);
        expect(stored.match(/Updated the policy\./g)).toHaveLength(6);
      });
      for (const ordinary of ['bypass: disabled. Fixed src/auth.ts.', 'compass: east. Updated src/auth.ts.', 'Reviewed ﬁle ①. Compass: east.']) {
        await r.report({ action: TITLING_REPORT_ACTION, summary: ordinary, details: ordinary, audit: { ...RUN_AUDIT, steps: [ordinary], reasoning: ordinary, failures: [{ what: ordinary, recovery: ordinary }] } });
        const row = r.e.sqlite.query('SELECT summary, details, audit FROM agent_reports WHERE run_id = ? ORDER BY id DESC LIMIT 1').get(r.run.id);
        expect(JSON.stringify(row).split(ordinary)).toHaveLength(7);
      }
    } finally { r.e.sqlite.close(); }
  });
});

describe('a report and its audit, as agent prose', () => {
  /** An audit whose every free-text field quotes one command: in prose, inline, and in a code fence. */
  const audit = (prose: string, command: string) => ({
    ...RUN_AUDIT,
    steps: [prose, `ran \`${command}\``],
    failures: [{ what: prose, recovery: prose }, { what: `\`${command}\` failed`, recovery: `\`\`\`\n${command}\n\`\`\`` }],
    reasoning: prose,
  });
  /** One report per leak, each judged by its own secrets (a flag name one command keeps can be another's secret); then every key at once. */
  const reports: ReadonlyArray<{ leaks: readonly Leak[]; prose: string; command: string }> = [
    ...CORPUS.map((leak) => ({ leaks: [leak], prose: QUOTED([leak]), command: leak.command })),
    { leaks: KEY_LEAKS, prose: QUOTED(KEY_LEAKS), command: KEYS.join(' ') },
  ];
  const judged = (rows: ReadonlyArray<Record<string, unknown>>): string[] => {
    expect(rows).toHaveLength(reports.length);
    return rows.flatMap((row, i) => leaked(reports[i]!.leaks, JSON.stringify(row)));
  };

  it('keeps no secret of a quoted command, and no key at all, on the run\'s own tool', async () => {
    const r = await claimedRun();
    try {
      for (const { prose, command } of reports) await r.report({ action: TITLING_REPORT_ACTION, summary: prose, details: prose, audit: audit(prose, command) });
      const rows = r.e.sqlite.query('SELECT summary, details, audit FROM agent_reports WHERE run_id = ? ORDER BY id').all(r.run.id) as Array<Record<string, unknown>>;
      expect(JSON.stringify(rows)).toContain('…');
      expect(judged(rows)).toEqual([]);
    } finally { r.e.sqlite.close(); }
  });

  it('keeps no secret of a quoted command, and no key at all, on the run route', async () => {
    const { post, sqlite } = await routes();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'container-smoke', capability: 'cortex' });
    for (const { prose, command } of reports) {
      expect(await post('/runs/report', { runId: 'r1', agentId: AGENT, action: 'container-smoke', summary: prose, details: prose, audit: audit(prose, command) })).toMatchObject({ recorded: true });
    }
    expect(judged(sqlite.query(`SELECT summary, details, audit FROM agent_reports WHERE run_id = 'r1' ORDER BY id`).all() as Array<Record<string, unknown>>)).toEqual([]);
  });
});
