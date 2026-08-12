import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { closeDatabase, getDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatchStateless } from '@myco/db/queries/batches.js';
import {
  buildDiagnosticBundle,
  EmptyWindowError,
  type BuildBundleOptions,
} from '@myco/capture/diagnostics/index.js';

const TRANSCRIPT_PROSE = 'ORCH_TRANSCRIPT_PROSE_planted';
const DAEMON_LOG_PROSE = 'ORCH_PROMPT_PREVIEW_planted';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'diag-bundle-'));
  dbPath = path.join(dir, 'myco.db');
  initDatabase(dbPath);
  createSchema(getDatabase());
});

afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Two overlapping in-window sessions + a batch + a fixture transcript on
 * disk for `sA` + a fake daemon.log with one in-window line (carrying a
 * planted `prompt_preview`) and one out-of-window line. `since`/`until`
 * bracket both sessions and the in-window log line but not the out-of-window
 * one.
 */
function seedBaseline(): { since: number; until: number; logDir: string; vaultDir: string; mycoHome: string } {
  const since = 1000;
  const until = 3000;

  const transcriptDir = mkdtempSync(path.join(tmpdir(), 'diag-transcript-'));
  const transcriptPath = path.join(transcriptDir, 'sA.jsonl');
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 't', message: { role: 'user', content: TRANSCRIPT_PROSE } }) + '\n',
  );

  upsertSession({
    id: 'sA',
    agent: 'claude-code',
    started_at: 1200,
    ended_at: 1800,
    created_at: 1200,
    transcript_path: transcriptPath,
  });
  upsertSession({
    id: 'sB',
    agent: 'claude-code',
    started_at: 1400,
    ended_at: 2600,
    created_at: 1400,
  });
  insertBatchStateless({ session_id: 'sA', created_at: 1250, started_at: 1250, user_prompt: 'hi there' });

  const logDir = mkdtempSync(path.join(tmpdir(), 'diag-logs-'));
  const inLine = JSON.stringify({
    timestamp: new Date(2000 * 1000).toISOString(),
    level: 'info',
    kind: 'hooks.prompt',
    component: 'hooks',
    message: 'User prompt received',
    session_id: 'sA',
    prompt_preview: DAEMON_LOG_PROSE,
    prompt_length: DAEMON_LOG_PROSE.length,
    origin: 'human',
  });
  const outLine = JSON.stringify({
    timestamp: new Date(50_000 * 1000).toISOString(),
    level: 'info',
    kind: 'hooks.prompt',
    component: 'hooks',
    message: 'User prompt received',
    session_id: 'sA',
    prompt_preview: 'OUT_OF_WINDOW_PROSE_should_not_matter',
  });
  writeFileSync(path.join(logDir, 'daemon.log'), inLine + '\n' + outLine + '\n');

  const vaultDir = mkdtempSync(path.join(tmpdir(), 'diag-vault-'));
  const mycoHome = mkdtempSync(path.join(tmpdir(), 'diag-home-'));

  return { since, until, logDir, vaultDir, mycoHome };
}

function baseOptions(seed: ReturnType<typeof seedBaseline>, outDir: string): BuildBundleOptions {
  return {
    groveId: 'g1',
    db: getDatabase(),
    vaultDir: seed.vaultDir,
    dbPath,
    mycoHome: seed.mycoHome,
    logDir: seed.logDir,
    config: { daemon: { port: 4155 } },
    mycoVersion: '9.9.9-test',
    window: { since: seed.since, until: seed.until },
    includeContent: false,
    outDir,
  };
}

describe('buildDiagnosticBundle', () => {
  test('builds a full bundle with default redaction; manifest.files matches the zip inventory', async () => {
    const seed = seedBaseline();
    const outDir = mkdtempSync(path.join(tmpdir(), 'diag-out-'));

    const result = await buildDiagnosticBundle(baseOptions(seed, outDir));

    expect(existsSync(result.filePath)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.manifest.doctor_vault_dir).toBe(seed.vaultDir);
    expect(result.manifest.collector_errors).toEqual([]);

    const unzipped = unzipSync(readFileSync(result.filePath));
    const names = Object.keys(unzipped);

    for (const expected of [
      'manifest.json',
      'environment.json',
      'doctor.json',
      'audit-report.json',
      'sessions.jsonl',
      'agent-runs.jsonl',
      'daemon-log.jsonl',
      'log-entries.jsonl',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.some((n) => n.startsWith('transcripts/') && n.endsWith('.skeleton.jsonl'))).toBe(true);
    expect(names).not.toContain('narrative.md');

    expect(names.slice().sort()).toEqual(result.manifest.files.slice().sort());

    const allText = names.map((n) => strFromU8(unzipped[n]!)).join('\n');
    expect(allText).not.toContain(TRANSCRIPT_PROSE);
    expect(allText).not.toContain(DAEMON_LOG_PROSE);

    // The cross-file join key: session_id survives verbatim in daemon-log.jsonl
    // (it's an opaque structural id, already verbatim in sessions.jsonl too),
    // even while prompt_preview on the same line is hashed.
    const daemonLog = strFromU8(unzipped['daemon-log.jsonl']!);
    expect(daemonLog).toContain('"sA"');
    expect(daemonLog).not.toContain(DAEMON_LOG_PROSE);
    expect(daemonLog).toContain('prompt_preview');
  });

  test('includeContent: true reveals transcript prose but daemon-log prompt_preview still never leaks', async () => {
    const seed = seedBaseline();
    const outDir = mkdtempSync(path.join(tmpdir(), 'diag-out-'));

    const result = await buildDiagnosticBundle({ ...baseOptions(seed, outDir), includeContent: true });

    const unzipped = unzipSync(readFileSync(result.filePath));
    const allText = Object.keys(unzipped)
      .map((n) => strFromU8(unzipped[n]!))
      .join('\n');

    expect(allText).toContain(TRANSCRIPT_PROSE);
    // The machine-global rule: daemon-log NEVER honors includeContent.
    expect(allText).not.toContain(DAEMON_LOG_PROSE);
    const daemonLog = strFromU8(unzipped['daemon-log.jsonl']!);
    expect(daemonLog).not.toContain(DAEMON_LOG_PROSE);
    // The join key still survives verbatim even with includeContent: true.
    expect(daemonLog).toContain('"sA"');
  });

  test('narrative.md is present only when a non-empty narrative is passed', async () => {
    const seed = seedBaseline();
    const outDir = mkdtempSync(path.join(tmpdir(), 'diag-out-'));

    const withNarrative = await buildDiagnosticBundle({
      ...baseOptions(seed, outDir),
      narrative: '  investigating a capture gap  ',
    });
    const unzippedWith = unzipSync(readFileSync(withNarrative.filePath));
    expect(unzippedWith['narrative.md']).toBeDefined();
    expect(strFromU8(unzippedWith['narrative.md']!)).toBe('investigating a capture gap\n');

    const withoutNarrative = await buildDiagnosticBundle(baseOptions(seed, outDir));
    const unzippedWithout = unzipSync(readFileSync(withoutNarrative.filePath));
    expect(unzippedWithout['narrative.md']).toBeUndefined();

    const blankNarrative = await buildDiagnosticBundle({ ...baseOptions(seed, outDir), narrative: '   ' });
    const unzippedBlank = unzipSync(readFileSync(blankNarrative.filePath));
    expect(unzippedBlank['narrative.md']).toBeUndefined();
  });

  test('a broken collector is isolated: the bundle still builds and the failure is recorded', async () => {
    // `vaultDir` cannot be used to force a doctor failure — runChecks
    // (doctor.ts:1639) is deliberately tolerant of a missing/invalid vault
    // dir (a bare `myco doctor` outside a project directory is a supported,
    // non-failing flow; verified empirically: it returns warn rows, never
    // throws). `dbPath` reliably fails instead: collectAudit's `runAudit`
    // opens an independent read-only bun:sqlite connection
    // (openReadonly, db/client.ts:158-163) that throws SQLITE_CANTOPEN for
    // a nonexistent file — the audit layer, not the doctor layer.
    const seed = seedBaseline();
    const outDir = mkdtempSync(path.join(tmpdir(), 'diag-out-'));

    const result = await buildDiagnosticBundle({
      ...baseOptions(seed, outDir),
      dbPath: path.join(dir, 'does-not-exist.db'),
    });

    expect(existsSync(result.filePath)).toBe(true);
    expect(result.manifest.collector_errors).toContainEqual(
      expect.objectContaining({ layer: 'audit' }),
    );

    const unzipped = unzipSync(readFileSync(result.filePath));
    expect(Object.keys(unzipped)).not.toContain('audit-report.json');
    // Every other collector still ran.
    expect(Object.keys(unzipped)).toContain('sessions.jsonl');
    expect(Object.keys(unzipped)).toContain('environment.json');
  });

  test('rejects with EmptyWindowError (up to 3 nearest sessions) when the window has zero sessions and zero log entries', async () => {
    upsertSession({ id: 's1', agent: 'claude-code', started_at: 1000, created_at: 1000 });
    upsertSession({ id: 's2', agent: 'claude-code', started_at: 2000, created_at: 2000 });
    upsertSession({ id: 's3', agent: 'claude-code', started_at: -500, created_at: -500 });
    upsertSession({ id: 's4', agent: 'claude-code', started_at: 50_000, created_at: 50_000 });

    const opts: BuildBundleOptions = {
      groveId: 'g1',
      db: getDatabase(),
      vaultDir: dir,
      dbPath,
      mycoHome: dir,
      logDir: dir,
      config: {},
      mycoVersion: '9.9.9-test',
      window: { since: 1, until: 2 },
      includeContent: false,
      outDir: dir,
    };

    let caught: unknown;
    try {
      await buildDiagnosticBundle(opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmptyWindowError);
    const err = caught as EmptyWindowError;
    // midpoint = 1.5; distances: s3=501.5, s1=998.5, s2=1998.5, s4=49998.5
    expect(err.nearestSessions.map((s) => s.id)).toEqual(['s3', 's1', 's2']);
  });

  test('retention sweep keeps only the newest 5 bundles per Grove in outDir', async () => {
    const seed = seedBaseline();
    const outDir = mkdtempSync(path.join(tmpdir(), 'diag-out-'));
    const safeGrove = 'retn-grove';

    const fakeNames: string[] = [];
    for (let i = 0; i < 6; i++) {
      const name = `myco-diagnostic-${safeGrove}-fake-${i}.zip`;
      const full = path.join(outDir, name);
      writeFileSync(full, 'x');
      const mtime = new Date(Date.now() - (10 - i) * 1000);
      utimesSync(full, mtime, mtime);
      fakeNames.push(name);
    }

    const result = await buildDiagnosticBundle({ ...baseOptions(seed, outDir), groveId: safeGrove });

    const remaining = readdirSync(outDir).filter(
      (n) => n.startsWith(`myco-diagnostic-${safeGrove}-`) && n.endsWith('.zip'),
    );
    expect(remaining.length).toBe(5);
    expect(remaining).toContain(path.basename(result.filePath));
    // The two oldest fakes (fake-0, fake-1) are pruned; fake-2..fake-5 survive.
    expect(remaining).not.toContain(fakeNames[0]);
    expect(remaining).not.toContain(fakeNames[1]);
    expect(remaining).toContain(fakeNames[5]);
  });
});
