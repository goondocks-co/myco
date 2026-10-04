import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { RUN_INSTRUCTIONS_FILES } from '../mcp-config.js';
import type { ChildProcess } from 'node:child_process';
import type { RunSpec } from '../events.js';
import { spawnGroup, stopGroup } from '../process-group.js';
import { locate } from '../detect.js';
import { grantsCall, type RunGrant } from './grant.js';
import { sourceToolAllows } from './source-access.js';
import { heldStderr, recordOf, type Started } from './stream.js';

/** SDK callbacks are blocking permission gates, including callback errors and timeouts. */
export function startClaudeSource(spec: RunSpec, grant: RunGrant, env: NodeJS.ProcessEnv, signal: AbortSignal): Started {
  const executable = locate('claude');
  if (executable === null || grant.source === null) throw new Error('Source permission enforcement is unavailable');
  const source = grant.source;
  const instructions = source.files.find((file) => RUN_INSTRUCTIONS_FILES.includes(basename(file)));
  const append = instructions === undefined ? '' : readFileSync(instructions, 'utf8');
  let child: ChildProcess | null = null;
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => child === null ? Promise.resolve() : stopping ??= stopGroup(child);
  const abortController = new AbortController();
  const kill = (): void => { abortController.abort(); void stop(); };
  signal.addEventListener('abort', kill, { once: true });
  if (signal.aborted) kill();
  let errors = '';
  let finish!: (code: number) => void;
  const exit = new Promise<number>((resolve) => { finish = resolve; });
  const run = query({
    prompt: spec.prompt,
    options: {
      pathToClaudeCodeExecutable: executable,
      cwd: spec.scratchDir,
      env,
      abortController,
      settingSources: [],
      persistSession: false,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      allowedTools: [...grant.rules],
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      spawnClaudeCodeProcess: (options) => {
        child = spawnGroup(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
        child.once('exit', () => { void stop(); });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => { errors = heldStderr(errors, chunk); });
        if (child.stdin === null || child.stdout === null) throw new Error('Source permission control pipes are unavailable');
        if (signal.aborted) kill();
        return Object.assign(child, { stdin: child.stdin, stdout: child.stdout });
      },
      ...(spec.profile === undefined ? {} : { model: spec.profile.model }),
      extraArgs: { 'permission-mode': 'manual', 'permission-prompts': 'none', 'strict-mcp-config': null, 'mcp-config': spec.mcpConfigPath, 'setting-sources': '', ...(spec.profile?.effort == null ? {} : { effort: spec.profile.effort }) },
      hooks: { PreToolUse: [{ hooks: [async (call) => {
        if (call.hook_event_name !== 'PreToolUse') return { continue: false };
        const input = recordOf(call.tool_input) ?? {};
        const allowed = ['Read', 'Glob', 'Grep'].includes(call.tool_name)
          ? sourceToolAllows(source, call.tool_name, input)
          : grantsCall(grant.rules, call.tool_name, typeof input.command === 'string' ? input.command : null);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny', permissionDecisionReason: 'Run source permission boundary' } };
      }] }] },
    },
  });
  async function* lines(): AsyncIterable<string> {
    let code = -1;
    try {
      for await (const message of run) yield JSON.stringify(message);
      code = 0;
    } finally {
      run.close();
      await stop();
      signal.removeEventListener('abort', kill);
      finish(code);
    }
  }
  return { lines: lines(), errorText: () => errors, exit, signal: () => signal.aborted ? 'SIGTERM' : null, kill };
}
