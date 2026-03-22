/**
 * CLI `curate` command — trigger a curation agent run.
 *
 * Accepts optional --task and --instruction flags to customize the run.
 * Delegates entirely to the agent executor.
 */

export async function run(args: string[], vaultDir: string): Promise<void> {
  const task = args.find((_, i) => args[i - 1] === '--task');
  const instruction = args.find((_, i) => args[i - 1] === '--instruction');

  console.log('Starting curation agent...');
  const { runCurationAgent } = await import('../agent/executor.js');
  const result = await runCurationAgent(vaultDir, { task, instruction });

  console.log(`\nCuration ${result.status}:`);
  console.log(`  Run ID: ${result.runId}`);
  if (result.tokensUsed) console.log(`  Tokens: ${result.tokensUsed}`);
  if (result.costUsd) console.log(`  Cost: $${result.costUsd.toFixed(4)}`);
  if (result.error) console.log(`  Error: ${result.error}`);
  if (result.reason) console.log(`  Reason: ${result.reason}`);
}
