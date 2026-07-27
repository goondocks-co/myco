import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
 *
 * Also redirects `CLAUDE_CONFIG_DIR` so the CLI writes its transcript outside
 * `~/.claude`. The env var stops a session ROW being created; it is invisible
 * to anything reading the transcript directory, where the file would otherwise
 * sit alongside real user sessions with no marker distinguishing it.
 */
export function scratchProbe(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query {
  const callerEnv = params.options?.env ?? (process.env as Record<string, string | undefined>);
  const sessionDir = path.join(os.tmpdir(), 'myco-scratch-probe-sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const claudeCodeExecutable = params.options?.pathToClaudeCodeExecutable ?? resolveClaudeCodeExecutable();
  return query({
    prompt: params.prompt,
    options: {
      ...(params.options ?? {}),
      env: {
        ...callerEnv,
        MYCO_AGENT_SESSION: '1',
        CLAUDE_CONFIG_DIR: callerEnv.CLAUDE_CONFIG_DIR ?? sessionDir,
      } as Record<string, string>,
      ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
    },
  });
}
