import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { harnessSessionIds } from '@myco/capture/audit/harness-sessions.js';
import {
  readHarnessRedirectEpoch,
  writeHarnessRedirectEpoch,
  stampHarnessRedirectEpoch,
  harnessSessionDir,
} from '@myco/agent/harness/redirect-epoch.js';
import { phaseSessionId } from '@myco/agent/wave-computation.js';

describe('harness session identification', () => {
  let dir: string;
  let db: Database;
  let tasksDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ids-'));
    db = new Database(path.join(dir, 'myco.db'));
    // Only the id column matters here; harness ids derive from it alone.
    db.run(`CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, agent_id TEXT, task TEXT, status TEXT, started_at INTEGER
    )`);
    tasksDir = path.join(dir, 'tasks');
    fs.mkdirSync(tasksDir);
    fs.writeFileSync(path.join(tasksDir, 'demo.yaml'), 'phases:\n  - name: explore\n  - name: persist\n');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedRun(id: string) {
    db.query(
      `INSERT INTO agent_runs (id, agent_id, task, status, started_at) VALUES ($id,'myco-agent','demo','completed',1)`,
    ).run({ $id: id });
  }

  it('recomputes a run phase session id exactly, without reading any transcript', () => {
    seedRun('run-abc');
    const ids = harnessSessionIds(db, tasksDir);
    expect(ids.has(phaseSessionId('run-abc', 'explore'))).toBe(true);
    expect(ids.has(phaseSessionId('run-abc', 'persist'))).toBe(true);
  });

  it('claims no id for a run it has never seen', () => {
    seedRun('run-abc');
    const ids = harnessSessionIds(db, tasksDir);
    // Identifies a subset, never a superset — a run aged out of agent_runs
    // must not be guessed at.
    expect(ids.has(phaseSessionId('run-never-recorded', 'explore'))).toBe(false);
  });

  it('returns empty rather than throwing on a vault without agent_runs', () => {
    const bare = new Database(':memory:');
    try {
      expect(harnessSessionIds(bare, tasksDir).size).toBe(0);
    } finally {
      bare.close();
    }
  });
});

describe('harness redirect epoch', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'redirect-epoch-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('is undefined before redirection has ever run', () => {
    expect(readHarnessRedirectEpoch(home)).toBeUndefined();
  });

  it('records the moment redirection first took effect', () => {
    const dir = harnessSessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    writeHarnessRedirectEpoch(dir, 1_785_000_000_000);
    expect(readHarnessRedirectEpoch(home)).toBe(1_785_000_000);
  });

  it('stamps at boot without waiting for a harness run', () => {
    // Redirection applies to every run the process will start, so boot is the
    // boundary. Deferring to the first run leaves a window in which
    // redirection is active but nothing can be dated against it.
    stampHarnessRedirectEpoch(home, 1_785_000_000_000);
    expect(readHarnessRedirectEpoch(home)).toBe(1_785_000_000);
  });

  it('keeps the original boundary across daemon restarts', () => {
    stampHarnessRedirectEpoch(home, 1_785_000_000_000);
    stampHarnessRedirectEpoch(home, 1_999_000_000_000);
    expect(readHarnessRedirectEpoch(home)).toBe(1_785_000_000);
  });

  it('never moves the boundary forward once stamped', () => {
    // A later stamp would reclassify already-separable transcripts as
    // ambiguous, undoing the separation redirection bought.
    const dir = harnessSessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    writeHarnessRedirectEpoch(dir, 1_785_000_000_000);
    writeHarnessRedirectEpoch(dir, 1_999_000_000_000);
    expect(readHarnessRedirectEpoch(home)).toBe(1_785_000_000);
  });
});
