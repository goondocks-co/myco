import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkIntegrity } from '@myco/capture/audit/checks/integrity.js';
import { checkClosure, hookClosingSymbionts } from '@myco/capture/audit/checks/closure.js';
import { checkDrift } from '@myco/capture/audit/checks/drift.js';
import { attributeByPathSlug, checkReconcile, intentionallyDropped } from '@myco/capture/audit/checks/reconcile.js';
import { captureModel, classifyRecency, symbiontContexts } from '@myco/capture/audit/context.js';
import { runAudit } from '@myco/capture/audit/index.js';
import { repair } from '@myco/capture/audit/repair.js';
import { ACTIVITIES_TABLE, PROMPT_BATCHES_TABLE, SESSIONS_TABLE } from '@myco/db/schema-ddl.js';

const HOUR = 3600;
const DAY = 24 * HOUR;

let dir: string;
let dbPath: string;
let db: Database;
const NOW = 1_785_000_000;

function seedSession(id: string, over: Partial<Record<string, unknown>> = {}) {
  const row = {
    id,
    agent: 'claude-code',
    project_id: 'proj_test',
    project_root: '/repo/test',
    started_at: NOW - DAY,
    status: 'completed',
    prompt_count: 0,
    created_at: NOW - DAY,
    ...over,
  };
  db.query(
    `INSERT INTO sessions (id, agent, project_id, project_root, started_at, status, prompt_count, created_at)
     VALUES ($id, $agent, $project_id, $project_root, $started_at, $status, $prompt_count, $created_at)`,
  ).run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v as never])));
}

function seedBatch(id: string, sessionId: string, over: Partial<Record<string, unknown>> = {}) {
  const row = {
    id,
    session_id: sessionId,
    project_id: 'proj_test',
    prompt_number: 1,
    kind: 'initial',
    origin: 'human',
    user_prompt: 'do the thing',
    status: 'completed',
    activity_count: 1,
    content_hash: 'hash',
    response_summary: 'done',
    started_at: NOW - DAY,
    created_at: NOW - DAY,
    ...over,
  };
  db.query(
    `INSERT INTO prompt_batches (id, session_id, project_id, prompt_number, kind, origin, user_prompt, status, activity_count, content_hash, response_summary, started_at, created_at)
     VALUES ($id, $session_id, $project_id, $prompt_number, $kind, $origin, $user_prompt, $status, $activity_count, $content_hash, $response_summary, $started_at, $created_at)`,
  ).run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v as never])));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-audit-'));
  dbPath = path.join(dir, 'myco.db');
  db = new Database(dbPath);
  db.run(SESSIONS_TABLE);
  db.run(PROMPT_BATCHES_TABLE);
  db.run(ACTIVITIES_TABLE);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('integrity checks', () => {
  it('reports NULL content_hash, which defeats dedup', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { content_hash: null });

    const ids = checkIntegrity(db, { dbPath }, NOW).map((f) => f.id);
    expect(ids).toContain('batch-null-content-hash');
  });

  it('does not count an injected envelope as a missing response', () => {
    // A runtime-injected envelope is not a conversational turn; roughly three
    // quarters of system-origin batches legitimately carry no response, so
    // counting them buries the human signal.
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { origin: 'system', response_summary: null });
    seedBatch('b2', 's1', { prompt_number: 2, origin: 'agent_dispatch', response_summary: null });

    const ids = checkIntegrity(db, { dbPath }, NOW).map((f) => f.id);
    expect(ids).not.toContain('batch-missing-response');
  });

  it('reports a human prompt whose response never landed', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { origin: 'human', response_summary: null });

    const finding = checkIntegrity(db, { dbPath }, NOW).find((f) => f.id === 'batch-missing-response');
    expect(finding?.count).toBe(1);
  });

  it('does not count an injected envelope as a zero-activity turn', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { origin: 'system', activity_count: 0 });

    const ids = checkIntegrity(db, { dbPath }, NOW).map((f) => f.id);
    expect(ids).not.toContain('batch-zero-activities');
  });

  it('does not report an active batch for a missing response — the turn is still running', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { status: 'active', response_summary: null });

    const ids = checkIntegrity(db, { dbPath }, NOW).map((f) => f.id);
    expect(ids).not.toContain('batch-missing-response');
  });

  it('reports counter drift between a session and its batches', () => {
    seedSession('s1', { prompt_count: 5 });
    seedBatch('b1', 's1', { prompt_number: 1 });

    const drift = checkIntegrity(db, { dbPath }, NOW).find((f) => f.id === 'session-counter-drift');
    expect(drift?.count).toBe(1);
  });

  it('does not call a legitimate prompt_number gap drift', () => {
    // prompt_count caches MAX(prompt_number), not a row count — reserved
    // numbers and stranded batches leave real gaps. A count-based comparison
    // reported all 95 gapped sessions in the dogfood vault as drifted.
    seedSession('s1', { prompt_count: 5 });
    seedBatch('b1', 's1', { prompt_number: 1 });
    seedBatch('b2', 's1', { prompt_number: 5 });

    const drift = checkIntegrity(db, { dbPath }, NOW).find((f) => f.id === 'session-counter-drift');
    expect(drift).toBeUndefined();
  });

  it('scopes to a project so one project cannot report another project rows', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { content_hash: null, project_id: 'proj_other' });

    const ids = checkIntegrity(db, { dbPath, projectId: 'proj_test' }, NOW).map((f) => f.id);
    expect(ids).not.toContain('batch-null-content-hash');
  });
});

describe('recency classification', () => {
  it('calls a class still occurring active', () => {
    expect(classifyRecency(NOW - HOUR, NOW)).toBe('active');
  });

  it('calls a class that stopped accruing legacy, so cleanup is bounded', () => {
    expect(classifyRecency(NOW - 60 * DAY, NOW)).toBe('legacy');
  });

  it('refuses to guess without a timestamp', () => {
    expect(classifyRecency(null, NOW)).toBe('unknown');
  });
});

describe('capture model', () => {
  it('treats agents whose transcripts are mined as hook-and-mining', () => {
    expect(captureModel('claude-code')).toBe('hook-and-mining');
    expect(captureModel('codex')).toBe('hook-and-mining');
  });

  it('treats plugin-reported agents as such, so a NULL transcript_path is not a defect', () => {
    // pi/opencode/cline post complete events from an in-agent plugin.
    expect(captureModel('opencode')).toBe('plugin-reported');
    expect(captureModel('pi')).toBe('plugin-reported');
    expect(captureModel('cline')).toBe('plugin-reported');
  });
});

describe('session closure', () => {
  const staleThresholdMs = HOUR * 1000;

  it('does not report a session inside the stale threshold', () => {
    seedSession('s1', { status: 'active', started_at: NOW - 60 });
    const { findings } = checkClosure(db, { dbPath }, NOW, { staleThresholdMs });
    expect(findings).toEqual([]);
  });

  it('leaves a long-running session alone while it is still active', () => {
    // Staleness is inactivity, not age. An earlier version keyed on
    // started_at and flagged every session older than the threshold —
    // including the live session doing the auditing.
    seedSession('s1', { agent: 'claude-code', status: 'active', started_at: NOW - 30 * HOUR });
    seedBatch('b1', 's1', { started_at: NOW - 60 });

    const { findings } = checkClosure(db, { dbPath }, NOW, { staleThresholdMs });
    expect(findings).toEqual([]);
  });

  it('blames the exit hook for an agent that closes via one', () => {
    seedSession('s1', { agent: 'claude-code', status: 'active', started_at: NOW - 5 * HOUR });
    seedBatch('b1', 's1', { started_at: NOW - 4 * HOUR });
    const { findings } = checkClosure(db, { dbPath }, NOW, { staleThresholdMs });
    expect(findings[0]?.id).toBe('closure-exit-hook-missed');
  });

  it('blames the sweep when it ran and left the session open', () => {
    seedSession('s1', { agent: 'codex', status: 'active', started_at: NOW - 5 * HOUR });
    const { findings } = checkClosure(db, { dbPath }, NOW, {
      staleThresholdMs,
      lastSweepAt: NOW - 60,
    });
    expect(findings[0]?.id).toBe('closure-sweep-missed');
  });

  it('blames the schedule when no sweep has run — a different root cause entirely', () => {
    seedSession('s1', { agent: 'codex', status: 'active', started_at: NOW - 5 * HOUR });
    const { findings } = checkClosure(db, { dbPath }, NOW, {
      staleThresholdMs,
      lastSweepAt: NOW - 90 * DAY,
    });
    expect(findings[0]?.id).toBe('closure-sweep-not-running');
  });

  it('reports a coverage gap rather than guessing when the sweep time is unknown', () => {
    seedSession('s1', { agent: 'codex', status: 'active', started_at: NOW - 5 * HOUR });
    const { findings, coverage } = checkClosure(db, { dbPath }, NOW, { staleThresholdMs });
    expect(findings).toEqual([]);
    expect(coverage[0]?.reason).toContain('cannot be told apart');
  });

  it('derives closure mode from the hook templates rather than a hardcoded list', () => {
    const closing = hookClosingSymbionts();
    expect(closing.has('claude-code')).toBe(true);
    // Sweep-closing by design per the 2026-06-12 ruling — not a defect.
    expect(closing.has('codex')).toBe(false);
    expect(closing.has('windsurf')).toBe(false);
  });
});

describe('reverse reconciliation', () => {
  it('never reports transcript loss for a plugin-reported agent', () => {
    const contexts = symbiontContexts('opencode');
    const { findings, coverage } = checkReconcile(db, { dbPath }, NOW, contexts);
    expect(findings).toEqual([]);
    expect(coverage[0]?.reason).toContain('Plugin-reported');
  });

  /** Write a codex-style rollout whose first line is the session_meta entry. */
  function plantCodexTranscript(payload: Record<string, unknown>): string {
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', timestamp: 'x', payload })}\n`);
    return file;
  }

  it('excludes a sub-agent thread — its turns are reattributed to the parent, not lost', () => {
    const file = plantCodexTranscript({
      id: '019f57ab-0000-0000-0000-000000000001',
      cwd: '/repo/test',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: '019f4cc0-be39-70d2-829d-bb92981279ab',
            agent_path: '/root/task_6_reviewer',
          },
        },
      },
    });
    expect(intentionallyDropped('codex', file)).toBe(true);
  });

  it('excludes a non-interactive exec run, which the manifest drops on purpose', () => {
    const file = plantCodexTranscript({ id: 'x', cwd: '/repo/test', source: 'exec' });
    expect(intentionallyDropped('codex', file)).toBe(true);
  });

  it('does NOT exclude an ordinary interactive session — that one really is loss', () => {
    const file = plantCodexTranscript({ id: 'y', cwd: '/repo/test', source: 'cli' });
    expect(intentionallyDropped('codex', file)).toBe(false);
  });
});

describe('runAudit', () => {
  it('opens the vault read-only, so a check cannot mutate it', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { content_hash: null });
    const before = fs.statSync(dbPath).size;

    const report = runAudit({ dbPath, projectId: 'proj_test' });

    expect(report.findings.some((f) => f.id === 'batch-null-content-hash')).toBe(true);
    expect(fs.statSync(dbPath).size).toBe(before);
  });

  it('orders findings by severity so the worst is read first', () => {
    seedSession('s1', { prompt_count: 9 });
    seedBatch('b1', 's1', { content_hash: null });
    seedBatch('b2', 's1', { status: 'completed', activity_count: 0 });

    const severities = runAudit({ dbPath, projectId: 'proj_test' }).findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === 'high' ? -1 : b === 'high' ? 1 : 0)));
  });

  it('always reports which capture model each symbiont uses', () => {
    const report = runAudit({ dbPath });
    expect(report.symbionts.find((s) => s.name === 'opencode')?.model).toBe('plugin-reported');
    expect(report.symbionts.find((s) => s.name === 'codex')?.model).toBe('hook-and-mining');
  });
});

describe('repair', () => {
  it('writes nothing without apply, however many rows it found', () => {
    seedSession('s1', { prompt_count: 9 });
    seedBatch('b1', 's1');

    const plan = repair({ dbPath, findingId: 'session-counter-drift' });

    expect(plan.rowCount).toBe(1);
    expect(plan.applied).toBe(false);
    expect(db.query('SELECT prompt_count c FROM sessions WHERE id = $id').get({ $id: 's1' })).toEqual({ c: 9 });
  });

  it('recomputes the counter as MAX(prompt_number), the value its writers cache', () => {
    seedSession('s1', { prompt_count: 9 });
    seedBatch('b1', 's1', { prompt_number: 1 });
    seedBatch('b2', 's1', { prompt_number: 5 });

    const plan = repair({ dbPath, findingId: 'session-counter-drift', apply: true });

    expect(plan.applied).toBe(true);
    // 5, not 2 — writing a row count here would clobber a correct value on
    // every session whose prompt_number has a gap.
    expect(db.query('SELECT prompt_count c FROM sessions WHERE id = $id').get({ $id: 's1' })).toEqual({ c: 5 });
  });

  it('leaves a gapped-but-correct session untouched', () => {
    seedSession('s1', { prompt_count: 5 });
    seedBatch('b1', 's1', { prompt_number: 1 });
    seedBatch('b2', 's1', { prompt_number: 5 });

    const plan = repair({ dbPath, findingId: 'session-counter-drift', apply: true });

    expect(plan.rowCount).toBe(0);
    expect(db.query('SELECT prompt_count c FROM sessions WHERE id = $id').get({ $id: 's1' })).toEqual({ c: 5 });
  });

  it('refuses to apply a change set over the threshold without acknowledgement', () => {
    for (let i = 0; i < 5; i++) {
      seedSession(`g${i}`, { prompt_count: 9 });
      seedBatch(`gb${i}`, `g${i}`, { prompt_number: 1 });
    }
    const plan = repair({ dbPath, findingId: 'session-counter-drift', apply: true, confirmThreshold: 2 });

    expect(plan.applied).toBe(false);
    expect(plan.refusal).toContain('confirmation threshold');
    expect(db.query('SELECT prompt_count c FROM sessions WHERE id = $id').get({ $id: 'g0' })).toEqual({ c: 9 });
  });

  it('backs the vault up before its first write', () => {
    seedSession('s1', { prompt_count: 9 });
    seedBatch('b1', 's1');

    const plan = repair({ dbPath, findingId: 'session-counter-drift', apply: true });

    expect(plan.backupPath).toBe(`${dbPath}.bak`);
    expect(fs.existsSync(`${dbPath}.bak`)).toBe(true);
  });

  it('flags a large change set for re-confirmation instead of applying it silently', () => {
    for (let i = 0; i < 5; i++) {
      seedSession(`s${i}`, { prompt_count: 9 });
      seedBatch(`b${i}`, `s${i}`);
    }
    const plan = repair({ dbPath, findingId: 'session-counter-drift', confirmThreshold: 2 });
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.applied).toBe(false);
  });

  it('refuses content_hash backfill rather than writing a wrong dedup key', () => {
    const plan = repair({ dbPath, findingId: 'batch-null-content-hash', apply: true });
    expect(plan.supported).toBe(false);
    expect(plan.refusal).toContain('ordinal');
  });

  it('refuses to delete orphaned batches, which hold captured work', () => {
    const plan = repair({ dbPath, findingId: 'batch-orphaned', apply: true });
    expect(plan.supported).toBe(false);
    expect(plan.refusal).toContain('forbidden');
  });

  it('refuses to write into a project holding an active write lease', () => {
    // Guarantee W1: a leased project is mid residency transition or Grove move,
    // and durable state written into the source Grove during that window is
    // deleted unshipped.
    const leasedProject = `proj_${'a'.repeat(32)}`;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-admission-'));
    const previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    try {
      fs.mkdirSync(path.join(home, 'leases'), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'leases', `${leasedProject}.json`),
        JSON.stringify({
          project_id: leasedProject,
          owner_op: 'grove-move',
          reason: 'residency transition',
          since: NOW,
          generation: 1,
          released_at: null,
        }),
      );

      db.query(
        `INSERT INTO sessions (id, agent, project_id, project_root, started_at, status, prompt_count, created_at)
         VALUES ('leased','claude-code',$p,'/repo/leased',$t,'completed',9,$t)`,
      ).run({ $p: leasedProject, $t: NOW - DAY });
      db.query(
        `INSERT INTO prompt_batches (id, session_id, project_id, prompt_number, kind, origin, status, created_at)
         VALUES ('lb1','leased',$p,1,'initial','human','completed',$t)`,
      ).run({ $p: leasedProject, $t: NOW - DAY });

      const plan = repair({ dbPath, findingId: 'session-counter-drift', apply: true });

      expect(plan.applied).toBe(false);
      expect(plan.refusal).toContain('Write admission denied');
      expect(db.query(`SELECT prompt_count c FROM sessions WHERE id = 'leased'`).get()).toEqual({ c: 9 });
    } finally {
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses an unknown finding id rather than doing nothing quietly', () => {
    const plan = repair({ dbPath, findingId: 'not-a-finding', apply: true });
    expect(plan.supported).toBe(false);
    expect(plan.refusal).toContain('Unknown finding id');
  });
});

describe('path-slug attribution', () => {
  const roots = ['/Users/chris/Repos/myco', '/Users/chris/Repos/myco-team'];

  it('recovers the project from a bare slug segment (Cursor)', () => {
    const p = '/Users/chris/.cursor/projects/Users-chris-Repos-myco/agent-transcripts/abc/abc.jsonl';
    expect(attributeByPathSlug(p, roots)).toBe('/Users/chris/Repos/myco');
  });

  it('recovers it from a leading-dash slug segment (Claude Code)', () => {
    const p = '/Users/chris/.claude/projects/-Users-chris-Repos-myco/abc.jsonl';
    expect(attributeByPathSlug(p, roots)).toBe('/Users/chris/Repos/myco');
  });

  it('does not let a shorter root claim a longer project name', () => {
    // A substring test would match `myco` inside `myco-team`.
    const p = '/Users/chris/.cursor/projects/Users-chris-Repos-myco-team/agent-transcripts/x/x.jsonl';
    expect(attributeByPathSlug(p, roots)).toBe('/Users/chris/Repos/myco-team');
  });

  it('returns null for a path belonging to no known project', () => {
    const p = '/Users/chris/.cursor/projects/Users-chris-Repos-other/agent-transcripts/x/x.jsonl';
    expect(attributeByPathSlug(p, roots)).toBeNull();
  });
});

describe('envelope drift', () => {
  it('flags a whole-prompt envelope stored with a human origin', () => {
    seedSession('s1', { agent: 'claude-code', prompt_count: 1 });
    seedBatch('b1', 's1', { user_prompt: '<agent-message from="rev">report body</agent-message>' });

    const findings = checkDrift(db, { dbPath }, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('envelope-classified-human');
    expect(findings[0]?.title).toContain('<agent-message>');
  });

  it('leaves a human prompt that merely starts with a tag alone', () => {
    // Envelope membership is whole-prompt, matching the manifests' fail-safe.
    // A prefix test would flag anyone asking about markup.
    seedSession('s1', { agent: 'claude-code', prompt_count: 1 });
    seedBatch('b1', 's1', { user_prompt: '<div> renders wrong, can you look at the CSS?' });

    expect(checkDrift(db, { dbPath }, NOW)).toEqual([]);
  });

  it('ignores prompts already carrying a non-human origin', () => {
    seedSession('s1', { agent: 'claude-code', prompt_count: 1 });
    seedBatch('b1', 's1', {
      origin: 'agent_dispatch',
      user_prompt: '<agent-message from="rev">report</agent-message>',
    });

    expect(checkDrift(db, { dbPath }, NOW)).toEqual([]);
  });

  it('flags a closed envelope followed by more content — the runtime-prefix shape', () => {
    // The shape that displaces a marker a `prompt_starts_with` rule matches.
    seedSession('s1', { agent: 'codex', prompt_count: 1 });
    seedBatch('b1', 's1', {
      user_prompt: '<recommended_plugins>list</recommended_plugins>\n# AGENTS.md instructions for /repo',
    });

    const findings = checkDrift(db, { dbPath }, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('envelope-prefixed-prompt-classified-human');
  });

  it('ignores an unclosed opening tag, which is prose not an envelope', () => {
    seedSession('s1', { agent: 'claude-code', prompt_count: 1 });
    seedBatch('b1', 's1', { user_prompt: '<section> is not closing properly, any idea why?' });

    expect(checkDrift(db, { dbPath }, NOW)).toEqual([]);
  });

  it('dates each tag separately so a closed gap is not aged by an open one', () => {
    seedSession('s1', { agent: 'claude-code', prompt_count: 2 });
    seedBatch('old', 's1', {
      user_prompt: '<teammate-message id="a">x</teammate-message>',
      created_at: NOW - 200 * DAY,
    });
    seedBatch('new', 's1', {
      prompt_number: 2,
      user_prompt: '<agent-message from="b">y</agent-message>',
      created_at: NOW - HOUR,
    });

    const byTag = Object.fromEntries(
      checkDrift(db, { dbPath }, NOW).map((f) => [f.title.match(/<([^>]+)>/)?.[1], f.recency]),
    );
    expect(byTag['teammate-message']).toBe('legacy');
    expect(byTag['agent-message']).toBe('active');
  });
});
