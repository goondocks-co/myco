import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { run } from '@myco/cli/setup.js';
import { runCutover } from '@myco/cli/cutover.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { legacyJourney, LEGACY_URLS } from './legacy-journey.js';

it('resumes the legacy journey after a parent-owned SIGKILL', async () => {
  const root = process.env.MYCO_SETUP_FIXTURE_ROOT!;
  const fixture = await legacyJourney(root, { multi: true, agents: ['claude-code', 'codex'] });
  const boundary = process.env.MYCO_SETUP_STOP_AFTER;
  const reached = (at: string) => {
    if (at !== boundary) return;
    fs.writeFileSync(path.join(root, 'reached'), at);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  const deps = { ...fixture.deps,
    ask: async () => { throw new Error('No-TTY resume must not ask again'); },
    runCutover: async (...args: Parameters<typeof runCutover>) => { reached('consent'); return runCutover(...args); },
    cutoverDeps: { ...fixture.deps.cutoverDeps, onCheckpoint: reached, stopDaemon: async () => {
      if (process.env.MYCO_SETUP_GROW && !fs.existsSync(path.join(root, 'grew'))) {
        const db = new Database(fixture.legacy.vault);
        try { db.run("INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, created_at) SELECT 'final_capture', agent, project_root, project_id, started_at, ended_at, status, created_at FROM sessions LIMIT 1"); } finally { db.close(); }
        fs.copyFileSync(fixture.legacy.vault, path.join(root, 'vault-before'));
        fs.writeFileSync(path.join(root, 'grew'), '1');
      }
      return 'none' as const;
    } },
  };
  try {
    expect(await run(process.env.MYCO_SETUP_RESUME ? ['--yes'] : ['--join', LEGACY_URLS[0], '--cutover', '--no-runner', '--yes'], deps)).toBe(0);
    expect(legacyMigrationState(fixture.legacy.mycoHome).state).toBe('moved');
    fs.writeFileSync(path.join(root, 'resumed'), JSON.stringify({ calls: fixture.calls }));
  } finally { await fixture.close(); }
}, 30_000);
