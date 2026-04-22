import { DaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { evaluateSessionCaptureRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { writeHookResponse } from './response.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
    if (!input.sessionId) return;
    const { sessionId, transcriptPath } = input;

    // Evaluate session_start rules before registering so drops never create
    // a row. Rules that inspect session_meta need the parsed transcript head.
    const transcriptMeta = transcriptPath ? readTranscriptMeta(transcriptPath) : undefined;
    const decision = evaluateSessionCaptureRules(symbiont, {
      transcriptPath,
      transcriptMeta: transcriptMeta ?? undefined,
    });
    if (decision.action === 'drop') {
      process.stderr.write(`[myco] session-start: dropped (${decision.reason ?? 'rule'})\n`);
      writeHookResponse(symbiont, 'session-start');
      return;
    }

    const client = new DaemonClient(VAULT_DIR);
    const healthy = await client.ensureRunning();
    if (!healthy) {
      writeHookResponse(symbiont, 'session-start');
      return;
    }

    let branch: string | undefined;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    } catch { /* not a git repo */ }

    const [, contextResult] = await Promise.all([
      client.post('/sessions/register', {
        session_id: sessionId,
        agent: symbiont,
        branch,
        started_at: new Date().toISOString(),
      }),
      client.post('/context', { session_id: sessionId, branch }),
    ]);

    if (contextResult.ok && contextResult.data?.text) {
      if (contextResult.data.source === 'cortex') {
        process.stderr.write('[myco] Injecting Myco Cortex instructions\n');
      }
      writeHookResponse(symbiont, 'session-start', { additionalContext: contextResult.data.text });
      return;
    }

    writeHookResponse(symbiont, 'session-start');
  } catch (error) {
    process.stderr.write(`[myco] session-start error: ${(error as Error).message}\n`);
    writeHookResponse(symbiont, 'session-start');
  }
}
