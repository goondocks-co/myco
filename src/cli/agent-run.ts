/**
 * CLI `agent` command — trigger an intelligence agent run via daemon API.
 *
 * Routes through the daemon HTTP API for centralized processing.
 * The daemon's /api/agent/run endpoint fires-and-forgets the run.
 */

import { connectToDaemon } from './shared.js';

export async function run(args: string[], vaultDir: string): Promise<void> {
  const task = args.find((_, i) => args[i - 1] === '--task');
  const instruction = args.find((_, i) => args[i - 1] === '--instruction');

  const client = await connectToDaemon(vaultDir);

  console.log('Starting agent...');
  const result = await client.post('/api/agent/run', { task, instruction });

  if (!result.ok) {
    console.error('Failed to start agent run');
    process.exit(1);
  }

  console.log('Agent run dispatched to daemon');
  if (result.data?.message) {
    console.log(`  ${result.data.message}`);
  }
}
