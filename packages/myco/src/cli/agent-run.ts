/**
 * CLI `agent` command — trigger an intelligence agent run via daemon API.
 *
 * Routes through the daemon HTTP API for centralized processing.
 * The daemon's /api/agent/run endpoint fires-and-forgets the run.
 */

import { connectToDaemon, printHelpIfRequested } from './shared.js';

const AGENT_USAGE = `Usage: myco agent [--task NAME] [--instruction TEXT] [--dry-run]

Options:
  --task NAME          Run a specific agent task. Defaults to the configured default task.
  --instruction TEXT  Additional instruction to pass to the agent run.
  --dry-run           Record intended writes without mutating vault state.
  -h, --help          Show this help
`;

export async function run(args: string[], vaultDir: string): Promise<void> {
  if (printHelpIfRequested(args, AGENT_USAGE)) return;

  const task = args.find((_, i) => args[i - 1] === '--task');
  const instruction = args.find((_, i) => args[i - 1] === '--instruction');
  const dryRun = args.includes('--dry-run');

  const client = await connectToDaemon(vaultDir);

  console.log('Starting agent...');
  const result = await client.post('/api/agent/run', { task, instruction, ...(dryRun ? { dryRun } : {}) });

  if (!result.ok) {
    console.error('Failed to start agent run');
    process.exit(1);
  }

  console.log('Agent run dispatched to daemon');
  if (result.data?.message) {
    console.log(`  ${result.data.message}`);
  }
}
