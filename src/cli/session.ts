/**
 * CLI: myco session — display session info via direct SQLite reads.
 *
 * Opens the database directly (WAL mode allows concurrent reads).
 * Does NOT require the daemon to be running.
 */

import { listSessions, getSession } from '@myco/db/queries/sessions.js';
import { initVaultDb } from './shared.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function run(args: string[], vaultDir: string): Promise<void> {
  const idOrLatest = args[0];

  const cleanup = initVaultDb(vaultDir);
  try {
    const sessions = listSessions({ limit: 100 });
    if (sessions.length === 0) {
      console.log('No sessions found');
      return;
    }

    // Resolve target session ID
    let targetId: string;
    if (!idOrLatest || idOrLatest === 'latest') {
      targetId = sessions[0].id;
    } else {
      const match = sessions.find((s) => s.id.includes(idOrLatest));
      if (!match) {
        console.error(`Session not found: ${idOrLatest}`);
        console.log('Available:', sessions.map((s) => s.id.slice(0, 12)).join(', '));
        return;
      }
      targetId = match.id;
    }

    // Fetch full session detail
    const target = getSession(targetId);
    if (!target) {
      console.error(`Failed to fetch session: ${targetId}`);
      return;
    }

    console.log(`Session: ${target.id}`);
    console.log(`Status:  ${target.status}`);
    if (target.title) console.log(`Title:   ${target.title}`);
    if (target.branch) console.log(`Branch:  ${target.branch}`);
    if (target.user) console.log(`User:    ${target.user}`);
    console.log(`Started: ${new Date(target.started_at * 1000).toISOString()}`);
    if (target.ended_at) console.log(`Ended:   ${new Date(target.ended_at * 1000).toISOString()}`);
    if (target.prompt_count) console.log(`Prompts: ${target.prompt_count}`);
    if (target.tool_count) console.log(`Tools:   ${target.tool_count}`);
    if (target.summary) console.log(`\nSummary:\n${target.summary}`);
  } catch (err) {
    console.error('Failed to read vault database:', (err as Error).message);
    process.exit(1);
  } finally {
    cleanup();
  }
}
