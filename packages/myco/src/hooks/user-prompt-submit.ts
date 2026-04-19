import { DaemonClient, isIgnoredEventResponse } from './client.js';
import { readStdin } from './read-stdin.js';
import { normalizeHookInput } from './normalize.js';
import { evaluateUserPromptRules } from './capture-rules.js';
import { readTranscriptMeta } from './transcript-meta.js';
import { loadManifests } from '../symbionts/detect.js';
import { EventBuffer } from '../capture/buffer.js';
import { resolveVaultDir } from '../vault/resolve.js';
import fs from 'node:fs';
import path from 'node:path';

export async function main() {
  const VAULT_DIR = resolveVaultDir();
  if (!fs.existsSync(path.join(VAULT_DIR, 'myco.yaml'))) return;

  try {
    const rawInput = JSON.parse(await readStdin());
    const input = normalizeHookInput(rawInput);
    const rawPrompt = input.prompt ?? '';
    const sessionId = input.sessionId;

    // Apply generic capture rules owned by each symbiont's manifest.
    // The hook stays symbiont-agnostic — per-agent behavior lives in YAML.
    // Pass structural context so rules can key on things like
    // `transcript_path_missing` without doing their own text mining.
    const transcriptMeta = input.transcriptPath ? readTranscriptMeta(input.transcriptPath) : undefined;
    const decision = evaluateUserPromptRules(loadManifests(), input.agent, {
      prompt: rawPrompt,
      transcriptPath: input.transcriptPath,
      transcriptMeta: transcriptMeta ?? undefined,
    });

    const client = new DaemonClient(VAULT_DIR);
    // Spawn daemon if needed but don't block on full health check backoff.
    // The event POST will fail fast if daemon isn't ready — buffer absorbs it.
    if (!(await client.isHealthy())) {
      client.spawnDaemon();
    }

    if (decision.action === 'drop') {
      // A rule classified this prompt as a phantom sub-invocation (e.g., an
      // agent's internal title-generation call). SessionStart already
      // registered the session row; delete it so it doesn't linger as a
      // zero-prompt ghost in the UI. Silently tolerate failures — the
      // session-maintenance sweep will clean up stragglers within the
      // stale threshold as a safety net.
      process.stderr.write(`[myco] user-prompt-submit: dropped (${decision.reason ?? 'rule'})\n`);
      await client.delete(`/api/sessions/${sessionId}`);
      return;
    }

    const prompt = decision.action === 'rewrite' ? decision.prompt : rawPrompt;
    if (decision.action === 'rewrite') {
      process.stderr.write(`[myco] user-prompt-submit: rewritten (${decision.reason ?? 'rule'})\n`);
    }

    // Forward prompt as event for capture
    const eventResult = await client.post('/events', {
      type: 'user_prompt',
      prompt,
      session_id: sessionId,
      agent: input.agent,
      transcript_path: input.transcriptPath,
    });

    // Buffer on transport failure OR server-side drop (200 with `ignored`).
    // A server-side drop means a capture rule discarded the event; buffering
    // it lets reconcileBufferBatches recover the prompt once the rule is fixed.
    if (!eventResult.ok || isIgnoredEventResponse(eventResult.data)) {
      const buffer = new EventBuffer(path.join(VAULT_DIR, 'buffer'), sessionId);
      buffer.append({ type: 'user_prompt', prompt, transcript_path: input.transcriptPath });
    }

    // Search for relevant spores to inject as context for this prompt.
    // The daemon does a vector search against the prompt text and returns
    // any high-relevance spores. This is fast (~20ms) — no LLM call.
    const contextResult = await client.post('/context/prompt', {
      prompt,
      session_id: sessionId,
    });

    // Always include the session ID so the agent can pass it to myco_remember.
    // Uses Session:: format consistent with daemon context injection (Branch::, Session::).
    const sessionLine = `Session:: \`${sessionId}\``;
    const contextText = contextResult.ok && contextResult.data?.text
      ? `${contextResult.data.text}\n${sessionLine}`
      : sessionLine;

    process.stdout.write(contextText);
  } catch (error) {
    process.stderr.write(`[myco] user-prompt-submit error: ${(error as Error).message}\n`);
  }
}
