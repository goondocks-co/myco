import { createHookDaemonClient } from './client.js';
import { readHookInput } from './input.js';
import { evaluateSessionCaptureRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { resolveProvisionedVaultDir } from './vault-gate.js';
import { writeHookResponse } from './response.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';
import { AntigravityJsonlParser } from '../symbionts/parsers/antigravity-jsonl.js';
import { runGit } from '../utils/git.js';
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

/**
 * Read with one retry. Antigravity IDE writes the transcript file
 * asynchronously after PreInvocation fires — the first read often
 * returns zero prompts because the file doesn't exist yet. A single
 * short retry catches the common case without holding the hook
 * response past the 10s timeout. Antigravity CLI writes the file
 * before firing the hook and hits the first attempt every time.
 */
const ANTIGRAVITY_TRANSCRIPT_RETRY_MS = 1500;
async function readAntigravityPromptsWithRetry(transcriptPath: string): Promise<string[]> {
  const first = readAntigravityPromptsFromTranscript(transcriptPath);
  if (first.length > 0) return first;
  await new Promise((resolve) => setTimeout(resolve, ANTIGRAVITY_TRANSCRIPT_RETRY_MS));
  return readAntigravityPromptsFromTranscript(transcriptPath);
}

export async function main(lockNamespace?: PerUserLockNamespace) {
  const VAULT_DIR = resolveProvisionedVaultDir(undefined, lockNamespace);
  if (!VAULT_DIR) return;

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

    const client = createHookDaemonClient(VAULT_DIR, { sessionId }, lockNamespace);
    const healthy = await client.ensureRunning();
    if (!healthy) {
      writeHookResponse(symbiont, 'session-start');
      return;
    }

    let branch: string | undefined;
    try {
      branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], process.cwd());
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
      transcript_path: transcriptPath,
    });
    let latestAntigravityPrompt: string | undefined;
    if (symbiont === 'antigravity' && transcriptPath) {
      // Antigravity IDE writes transcript_full.jsonl asynchronously —
      // the file is typically not on disk when PreInvocation fires for
      // the first turn. Retry once with a short delay. The CLI flavor
      // hits the happy path on the first attempt; only the IDE pays
      // the retry cost, and only on the first turn per session.
      const prompts = await readAntigravityPromptsWithRetry(transcriptPath);
      if (prompts.length > 0) {
        await client.post('/events/sync-transcript-prompts', {
          session_id: sessionId,
          prompts,
        });
        latestAntigravityPrompt = prompts[prompts.length - 1];
      }
    }
    const contextResult = await client.post('/context', { session_id: sessionId, branch, agent: symbiont });

    // Spore injection for AGY: call /context/prompt with the latest prompt so
    // semantic spores attach to the just-recorded batch. Other symbionts run
    // this from user-prompt-submit.ts; AGY has no equivalent hook.
    let spores = '';
    if (latestAntigravityPrompt) {
      const promptResult = await client.post('/context/prompt', {
        prompt: latestAntigravityPrompt,
        session_id: sessionId,
      });
      if (promptResult.ok && promptResult.data?.text) {
        spores = promptResult.data.text;
      }
    }

    const cortex = contextResult.ok && contextResult.data?.text ? contextResult.data.text : '';
    // Pass cortex and spores as SEPARATE injection blocks so symbionts
    // that support per-block rendering (Antigravity → separate
    // `injectSteps`) display them as distinct events. Plain-text
    // symbionts get them joined via the fallback path in response.ts,
    // so existing behavior there is preserved.
    const steps = [cortex, spores].filter((s) => s.length > 0);
    if (steps.length > 0) {
      if (contextResult.ok && contextResult.data?.source === 'cortex') {
        process.stderr.write('[myco] Injecting Myco Cortex instructions\n');
      }
      writeHookResponse(symbiont, 'session-start', { additionalSteps: steps });
      return;
    }

    writeHookResponse(symbiont, 'session-start');
  } catch (error) {
    process.stderr.write(`[myco] session-start error: ${(error as Error).message}\n`);
    writeHookResponse(symbiont, 'session-start');
  }
}
