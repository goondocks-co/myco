import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { runCutover } from '@myco/cli/cutover.js';
import { legacyJourney } from './legacy-journey.js';

export async function legacyInterruption(root: string, options: { growth?: boolean; boundary?: string } = {}) {
  const fixture = await legacyJourney(root, { multi: true, agents: ['claude-code', 'codex'] });
  const reached = (at: string) => {
    if (at !== options.boundary) return;
    fs.writeFileSync(path.join(root, 'reached'), at);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  const deps = { ...fixture.deps,
    ask: async () => { throw new Error('No-TTY resume must not ask again'); },
    runCutover: async (...args: Parameters<typeof runCutover>) => { reached('consent'); return runCutover(...args); },
    cutoverDeps: { ...fixture.deps.cutoverDeps, onCheckpoint: reached, stopDaemon: async () => {
      if (options.growth && !fs.existsSync(path.join(root, 'grew'))) {
        const db = new Database(fixture.legacy.vault);
        try { db.run("INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, created_at) SELECT 'final_capture', agent, project_root, project_id, started_at, ended_at, status, created_at FROM sessions LIMIT 1"); } finally { db.close(); }
        fs.copyFileSync(fixture.legacy.vault, path.join(root, 'vault-before'));
        fs.writeFileSync(path.join(root, 'grew'), '1');
      }
      return 'none' as const;
    } },
  };
  return { ...fixture, deps };
}
