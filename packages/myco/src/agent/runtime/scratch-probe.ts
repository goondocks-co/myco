import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCodeExecutable } from './claude-code-executable.js';

/**
 * `query()` wrapper for scratch / verification scripts run inside this repo.
 *
 * Sets `MYCO_AGENT_SESSION=1` in the spawned process env so the Myco hook
 * guard (`packages/myco/src/symbionts/templates/myco-run.cjs`) no-ops and
 * the probe doesn't get captured as a user session. Without this, every
 * SDK `query()` call from the repo pollutes the vault session list with
 * sub-second single-prompt entries.
 */
export function scratchProbe(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query {
  const callerEnv = params.options?.env ?? (process.env as Record<string, string | undefined>);
  const claudeCodeExecutable = params.options?.pathToClaudeCodeExecutable ?? resolveClaudeCodeExecutable();
  return query({
    prompt: params.prompt,
    options: {
      ...(params.options ?? {}),
      env: { ...callerEnv, MYCO_AGENT_SESSION: '1' } as Record<string, string>,
      ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
    },
  });
}
