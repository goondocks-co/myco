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
 * so exercising the real enumeration path requires controlling
 * `os.homedir()` — Bun's `os.homedir()` does not re-read `process.env.HOME`
 * once the process has started, so an env override alone (used elsewhere in
 * this suite for `MYCO_HOME`, which IS read fresh from the env on every
 * call) does not sandbox it. `mock.module('node:os', ...)` does, at the
 * cost of running this file `--isolate`d (auto-detected by
 * run-bun-tests.mjs whenever a file calls mock.module()), so the override
 * never leaks into sibling test files.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';

const MOCK_HOME = `/tmp/myco-sdk-entrypoint-home-${process.pid}-${Date.now()}`;

mock.module('node:os', () => ({
  default: { homedir: () => MOCK_HOME },
  homedir: () => MOCK_HOME,
}));

import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

import { checkReconcile } from '@myco/capture/audit/checks/reconcile.js';
import { symbiontContexts } from '@myco/capture/audit/context.js';
import { ACTIVITIES_TABLE, PROMPT_BATCHES_TABLE, SESSIONS_TABLE } from '@myco/db/schema-ddl.js';

const NOW = 1_785_000_000;
const PROJECT_ROOT = '/repo/sdktest';
const PROJECT_ID = 'proj_sdktest';
const PROJECTS_DIR = path.join(MOCK_HOME, '.claude', 'projects', 'sdktest');

let dbDir: string;
let dbPath: string;
let db: Database;
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
  const file = path.join(PROJECTS_DIR, `${sessionId}.jsonl`);
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

beforeAll(() => {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
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

  prevMycoHome = process.env.MYCO_HOME;
  // Unredirected: no `.myco-redirect-epoch` marker exists under this
  // sandboxed home, so readHarnessRedirectEpoch() returns undefined and the
  // predating-redirect bucket stays out of the way of this fixture.
  process.env.MYCO_HOME = path.join(MOCK_HOME, '.myco');
});

afterAll(() => {
  if (prevMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = prevMycoHome;
  db.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(MOCK_HOME, { recursive: true, force: true });
});

describe('checkReconcile — claude-code SDK-entrypoint parity', () => {
  it('does not report transcript-never-captured for an sdk-py transcript with no session row', () => {
    plantTranscript('sdk-session-py', 'sdk-py');

    const { findings, coverage } = checkReconcile(db, { dbPath }, NOW, symbiontContexts('claude-code'));

    expect(findings.find((f) => f.id === 'transcript-never-captured' && f.samples?.includes('sdk-session-py'))).toBeUndefined();
    expect(coverage.some((c) => c.reason.includes('no session row by design'))).toBe(true);
  });

  it('does not report transcript-never-captured for an sdk-ts transcript with no session row', () => {
    plantTranscript('sdk-session-ts', 'sdk-ts');

    const { findings } = checkReconcile(db, { dbPath }, NOW, symbiontContexts('claude-code'));

    expect(findings.find((f) => f.id === 'transcript-never-captured' && f.samples?.includes('sdk-session-ts'))).toBeUndefined();
  });

  it('negative control: a cli-entrypoint transcript with no session row STILL produces the finding', () => {
    plantTranscript('cli-session', 'cli');

    const { findings } = checkReconcile(db, { dbPath }, NOW, symbiontContexts('claude-code'));

    const finding = findings.find((f) => f.id === 'transcript-never-captured');
    expect(finding).toBeDefined();
    expect(finding?.samples).toContain('cli-session');
  });
});
