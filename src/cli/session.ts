/**
 * CLI: myco session — display a session from PGlite.
 */

import { initDatabaseForVault } from '@myco/db/client.js';
import { getSession, listSessions } from '@myco/db/queries/sessions.js';

export async function run(args: string[], vaultDir: string): Promise<void> {
  const idOrLatest = args[0];

  await initDatabaseForVault(vaultDir);

  const sessions = await listSessions({ limit: 100 });

  if (sessions.length === 0) {
    console.log('No sessions found');
    return;
  }

  let target;
  if (!idOrLatest || idOrLatest === 'latest') {
    target = sessions[0]; // listSessions returns newest first
  } else {
    target = sessions.find((s) => s.id.includes(idOrLatest));
  }

  if (!target) {
    console.error(`Session not found: ${idOrLatest}`);
    console.log('Available:', sessions.map((s) => s.id.slice(0, 12)).join(', '));
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
}
