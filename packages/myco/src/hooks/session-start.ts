import { createHookDaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { evaluateSessionCaptureRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { writeHookResponse } from './response.js';
import { AntigravityJsonlParser } from '../symbionts/parsers/antigravity-jsonl.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const antigravityParser = new AntigravityJsonlParser();

/**
 * Read AGY `transcript_full.jsonl` and return the user prompts in order. Empty
 * array on missing/unreadable transcript so callers can no-op.
 */
export function readAntigravityPromptsFromTranscript(transcriptPath: string): string[] {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    return antigravityParser
      .parseTurns(content)
      .map((t) => t.prompt)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

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

    const client = createHookDaemonClient(VAULT_DIR, { sessionId });
    const healthy = await client.ensureRunning();
    if (!healthy) {
      writeHookResponse(symbiont, 'session-start');
      return;
    }

    let branch: string | undefined;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    } catch { /* not a git repo */ }

    // Antigravity has no UserPromptSubmit equivalent — PreInvocation fires
    // per-execution and the user prompt lives in `transcript_full.jsonl`.
    // Register the session, drain newly-seen prompts into prompt_batches, then
    // call /context so Cortex injection attaches to the just-created batch.
    await client.capturePost('/sessions/register', {
      session_id: sessionId,
      agent: symbiont,
      branch,
      started_at: new Date().toISOString(),
    });
    if (symbiont === 'antigravity' && transcriptPath) {
      const prompts = readAntigravityPromptsFromTranscript(transcriptPath);
      if (prompts.length > 0) {
        await client.post('/events/sync-transcript-prompts', {
          session_id: sessionId,
          prompts,
        });
      }
    }
    const contextResult = await client.post('/context', { session_id: sessionId, branch });

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
