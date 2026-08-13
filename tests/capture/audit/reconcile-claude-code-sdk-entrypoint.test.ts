/**
 * checkReconcile end-to-end for Claude Code's SDK-entrypoint drop rules.
 *
 * Claude Code >=2.1.x writes Agent-SDK-launched sessions (e.g. the
 * security-review plugin's Python-SDK review agents) into the same
 * ~/.claude/projects/<slug>/*.jsonl tree as interactive sessions, as
 * top-level files that never fire hooks — only checkReconcile's disk sweep
 * (via intentionallyDropped -> evaluateSessionCaptureRules) ever sees them.
 * Their structural marker is `entrypoint: "sdk-py"` / `"sdk-ts"`;
 * interactive sessions carry `entrypoint: "cli"`.
 *
 * claude-code.yaml's manifest declares a literal `~/.claude/projects` root,
 * so exercising the real enumeration path requires sandboxing where `~`
 * expands to. `expandRoot()` (transcript-discovery.ts) expands `~` against
 * `process.env.HOME` (falling back to `os.homedir()` only when HOME is
 * unset), read fresh on every call via its default parameter — so setting
 * `process.env.HOME` before calling `checkReconcile()` is sufficient. No
 * module mocking needed, which means this file runs unisolated and cannot
 * leak a partial `node:os` replacement into sibling tests (a real incident:
 * an earlier revision here globally replaced the `node:os` module, which
 * lacked `tmpdir`, and broke `tests/capture/audit/{tombstone-gate,
 * prompt-count-parity,...}` when the full gate ran them in a shared
 * process).
 *
 * Each test gets its own fresh HOME, project directory, and vault: no
 * cumulative planting across tests, so a `coverage`/`findings` assertion can
 * be exact (a full row/count match) rather than a "contains the substring"
 * probe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

import { checkReconcile } from '@myco/capture/audit/checks/reconcile.js';
import { symbiontContexts } from '@myco/capture/audit/context.js';
import { ACTIVITIES_TABLE, PROMPT_BATCHES_TABLE, SESSIONS_TABLE } from '@myco/db/schema-ddl.js';

const NOW = 1_785_000_000;
const PROJECT_ROOT = '/repo/sdktest';
const PROJECT_ID = 'proj_sdktest';

let homeDir: string;
let projectsDir: string;
let dbDir: string;
let dbPath: string;
let db: Database;
let prevHome: string | undefined;
let prevMycoHome: string | undefined;

function seedSession(id: string, over: Partial<Record<string, unknown>> = {}) {
  const row = {
    id,
    agent: 'claude-code',
    project_id: null,
    project_root: null,
    started_at: NOW - 3600,
    status: 'completed',
    prompt_count: 0,
    created_at: NOW - 3600,
    ...over,
  };
  db.query(
    `INSERT INTO sessions (id, agent, project_id, project_root, started_at, status, prompt_count, created_at)
     VALUES ($id, $agent, $project_id, $project_root, $started_at, $status, $prompt_count, $created_at)`,
  ).run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v as never])));
}

/**
 * Realistic SDK-shaped transcript: `queue-operation` first line (no
 * `entrypoint`), an `attachment` record a few lines in carrying
 * `entrypoint`/`cwd`, then a user/assistant turn — the shape
 * transcript-meta.ts's bounded header scan is built to see through.
 */
function plantTranscript(sessionId: string, entrypoint: string): string {
  const file = path.join(projectsDir, `${sessionId}.jsonl`);
  const lines = [
    { type: 'queue-operation', id: 'op1' },
    { type: 'last-prompt', value: null },
    { type: 'attachment', cwd: PROJECT_ROOT, version: '2.1.30', userType: 'external', gitBranch: 'main', entrypoint },
    { type: 'user', message: { role: 'user', content: 'review this diff' } },
    { type: 'assistant', message: { role: 'assistant', content: 'looks fine' } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join('/tmp', `myco-sdk-entrypoint-home-${process.pid}-`));
  projectsDir = path.join(homeDir, '.claude', 'projects', 'sdktest');
  fs.mkdirSync(projectsDir, { recursive: true });

  dbDir = fs.mkdtempSync(path.join('/tmp', `myco-sdk-entrypoint-db-${process.pid}-`));
  dbPath = path.join(dbDir, 'myco.db');
  db = new Database(dbPath);
  db.run(SESSIONS_TABLE);
  db.run(PROMPT_BATCHES_TABLE);
  db.run(ACTIVITIES_TABLE);

  // A tracked project this grove knows about — required so an attributed
  // orphan resolves to a real project_id rather than falling into the
  // 'unattributable' bucket.
  seedSession('known-session', { project_id: PROJECT_ID, project_root: PROJECT_ROOT });

  prevHome = process.env.HOME;
  prevMycoHome = process.env.MYCO_HOME;
  process.env.HOME = homeDir;
  // Unredirected: no `.myco-redirect-epoch` marker exists under this
  // sandboxed home, so readHarnessRedirectEpoch() returns undefined and the
  // predating-redirect bucket stays out of the way of this fixture.
  process.env.MYCO_HOME = path.join(homeDir, '.myco');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = prevMycoHome;
  db.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('checkReconcile — claude-code SDK-entrypoint parity', () => {
  it('excludes an sdk-py transcript with no session row as deliberate, not a finding', () => {
    plantTranscript('sdk-session-py', 'sdk-py');

    const { findings, coverage } = checkReconcile(db, { dbPath }, NOW, symbiontContexts('claude-code'));

    expect(findings).toEqual([]);
    expect(coverage).toEqual([
      {
        symbiont: 'claude-code',
        scope: 'transcript reconciliation',
        reason:
          '1 transcript(s) have no session row by design — sub-agent threads whose turns are reattributed to the parent session, plus manifest-dropped classes (non-interactive exec, ephemeral sub-invocations). Excluded from findings.',
      },
    ]);
  });

  it('excludes an sdk-ts transcript with no session row as deliberate, not a finding', () => {
    plantTranscript('sdk-session-ts', 'sdk-ts');

    const { findings, coverage } = checkReconcile(db, { dbPath }, NOW, symbiontContexts('claude-code'));

    expect(findings).toEqual([]);
    expect(coverage).toEqual([
      {
        symbiont: 'claude-code',
        scope: 'transcript reconciliation',
        reason:
          '1 transcript(s) have no session row by design — sub-agent threads whose turns are reattributed to the parent session, plus manifest-dropped classes (non-interactive exec, ephemeral sub-invocations). Excluded from findings.',
      },
    ]);
  });

  it('negative control: a cli-entrypoint transcript with no session row STILL produces the finding', () => {
    plantTranscript('cli-session', 'cli');

    const { findings, coverage } = checkReconcile(db, { dbPath }, NOW, symbiontContexts('claude-code'));

    expect(coverage).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'transcript-never-captured',
      severity: 'high',
      symbiont: 'claude-code',
      count: 1,
      samples: ['cli-session'],
    });
  });
});
