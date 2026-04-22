// One-off backfill: re-run reconcileBatchKinds for a session that missed
// reconciliation due to a prior bug in the transcript miner (see
// feat/steering-prompt-capture history). Runs directly against source via
// tsx so we don't depend on the bundled dist layout.
//
// Usage: npx tsx packages/myco/scripts/reconcile-session-batches.ts <sessionId> [--agent <name>]
import path from 'node:path';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/client.js';
import { TranscriptMiner } from '../src/capture/transcript-miner.js';

const args = process.argv.slice(2);
const sessionId = args[0];
if (!sessionId) {
  console.error('usage: reconcile-session-batches.ts <sessionId> [--agent <name>]');
  process.exit(2);
}
const agentFlag = args.indexOf('--agent');
const agentOverride = agentFlag !== -1 ? args[agentFlag + 1] : null;

const vaultDir = process.env.MYCO_VAULT_DIR
  || path.resolve(process.cwd(), '.myco');

initDatabase(path.join(vaultDir, 'myco.db'));

// Separate read-only handle so we can look up the session without disturbing
// the initialized write handle above.
const lookup = new Database(path.join(vaultDir, 'myco.db'), { readonly: true });
const row = lookup.prepare<[string], { id: string; agent: string | null; transcript_path: string | null }>(
  'SELECT id, agent, transcript_path FROM sessions WHERE id = ?',
).get(sessionId);
lookup.close();

if (!row) {
  console.error(`session not found: ${sessionId}`);
  process.exit(1);
}
if (!row.transcript_path) {
  console.error(`session has no transcript_path; cannot reconcile`);
  process.exit(1);
}

const agent = agentOverride ?? row.agent ?? 'claude-code';
console.log(`reconciling session=${sessionId} agent=${agent} transcript=${row.transcript_path}`);

const miner = new TranscriptMiner();
const result = miner.reconcileBatchKinds(sessionId, {
  agent,
  transcriptPath: row.transcript_path,
});

console.log('result:', JSON.stringify(result, null, 2));
