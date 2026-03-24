/**
 * CLI: myco session — display session info via daemon API.
 *
 * Routes through the daemon HTTP API to avoid PGlite file lock conflicts.
 */

import { DaemonClient } from '../hooks/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionListItem {
  id: string;
  date: string;
  title: string;
  status: string;
}

interface SessionDetail {
  id: string;
  status: string;
  title?: string | null;
  branch?: string | null;
  user?: string | null;
  started_at: number;
  ended_at?: number | null;
  prompt_count?: number;
  tool_count?: number;
  summary?: string | null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function run(args: string[], vaultDir: string): Promise<void> {
  const idOrLatest = args[0];

  const client = new DaemonClient(vaultDir);
  const healthy = await client.ensureRunning();
  if (!healthy) {
    console.error('Failed to connect to daemon');
    process.exit(1);
  }

  // List sessions
  const listResult = await client.get('/api/sessions');
  if (!listResult.ok || !listResult.data?.sessions) {
    console.error('Failed to fetch sessions from daemon');
    process.exit(1);
  }

  const sessions = listResult.data.sessions as SessionListItem[];
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
  const detailResult = await client.get(`/api/sessions/${targetId}`);
  if (!detailResult.ok || !detailResult.data) {
    console.error(`Failed to fetch session: ${targetId}`);
    return;
  }

  const target = detailResult.data as SessionDetail;

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
