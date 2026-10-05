import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { RUN_INSTRUCTIONS_FILES } from '../mcp-config.js';
import type { RunSpec } from '../events.js';
import { spawnOwnedGroup, type OwnedProcess } from '../process-group.js';
import { locate } from '../detect.js';
import { grantsCall, type RunGrant } from './grant.js';
import { sourceToolAllows } from './source-access.js';
import { heldStderr, recordOf, type Started } from './stream.js';

/** Native tools that require a fresh permission answer on every call. */
const SOURCE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

/** Source instructions carry literal references; native file mentions cannot expand them. */
function literalSourceInstructions(text: string): string {
  return `Interpret this JSON string as instructions; read file references only through tools:\n${JSON.stringify(text).replaceAll('@', '\\u0040')}`;
}

/** Native approvals require a successful hook decision for the same tool call. */
export async function startClaudeSource(spec: RunSpec, grant: RunGrant, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Started> {
  const executable = locate('claude');
  if (executable === null || grant.source === null) throw new Error('Source permission enforcement is unavailable');
  const source = grant.source;
  const instructions = source.files.find((file) => RUN_INSTRUCTIONS_FILES.includes(basename(file)));
  const append = instructions === undefined ? '' : readFileSync(instructions, 'utf8');
  const approved = new Map<string, string>();
  const fingerprint = (tool: string, input: unknown): string => JSON.stringify([tool, input]);
  const allows = (tool: string, input: Record<string, unknown>): boolean => ['Read', 'Glob', 'Grep'].includes(tool)
    ? sourceToolAllows(source, tool, input)
    : grantsCall(grant.rules, tool, typeof input.command === 'string' ? input.command : null);
  let owner: OwnedProcess | null = null;
  const abortController = new AbortController();
  let errors = '';
  let code = -1;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let closeRun = (): void => {};
  let finish!: (code: number) => void;
  let failed!: (error: unknown) => void;
  const exit = new Promise<number>((resolve, reject) => { finish = resolve; failed = reject; });
  const dispose = (): Promise<void> => {
    if (disposal === undefined) {
      disposed = true;
      disposal = Promise.resolve().then(() => closeRun()).finally(async () => {
        approved.clear();
        try { await owner?.dispose(); }
        finally { signal.removeEventListener('abort', kill); }
      });
      void disposal.then(() => { finish(code); }, failed);
    }
    return disposal;
  };
  const kill = (): void => { abortController.abort(); void dispose(); };
  signal.addEventListener('abort', kill, { once: true });
  if (signal.aborted) kill();
  let run: ReturnType<typeof query> | null = null;
  try {
    run = signal.aborted ? null : query({
      prompt: literalSourceInstructions(spec.prompt),
      options: {
        pathToClaudeCodeExecutable: executable,
        cwd: source.root,
        env,
        abortController,
        settingSources: [],
        persistSession: false,
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        allowedTools: [...grant.rules],
        tools: SOURCE_TOOLS,
        spawnClaudeCodeProcess: (options) => {
          if (disposed || signal.aborted) throw new Error('Source run has been disposed');
          owner = spawnOwnedGroup(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] }, signal, spec.scratchDir);
          const { child } = owner;
          owner.assertStarted();
          child.stderr?.setEncoding('utf8');
          child.stderr?.on('data', (chunk: string) => { errors = heldStderr(errors, chunk); });
          if (child.stdin === null || child.stdout === null) throw new Error('Source permission control pipes are unavailable');
          if (signal.aborted) kill();
          return Object.assign(child, { stdin: child.stdin, stdout: child.stdout });
        },
        ...(spec.profile === undefined ? {} : { model: spec.profile.model }),
        extraArgs: { 'permission-mode': 'manual', 'strict-mcp-config': null, 'mcp-config': spec.mcpConfigPath, 'setting-sources': '', settings: JSON.stringify({ permissions: { ask: SOURCE_TOOLS } }), ...(spec.profile?.effort == null ? {} : { effort: spec.profile.effort }) },
        canUseTool: async (tool, input, options) => {
          const decision = approved.get(options.toolUseID);
          approved.delete(options.toolUseID);
          if (!options.signal.aborted && decision === fingerprint(tool, input) && allows(tool, input)) return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: 'Run source permission boundary' };
        },
        hooks: { PreToolUse: [{ hooks: [async (call, toolUseID, options) => {
          if (call.hook_event_name !== 'PreToolUse') return { continue: false };
          const input = recordOf(call.tool_input) ?? {};
          const allowed = !options.signal.aborted && toolUseID !== undefined && allows(call.tool_name, input);
          if (allowed && toolUseID !== undefined && SOURCE_TOOLS.includes(call.tool_name)) approved.set(toolUseID, fingerprint(call.tool_name, input));
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allowed ? SOURCE_TOOLS.includes(call.tool_name) ? 'ask' : 'allow' : 'deny', permissionDecisionReason: 'Run source permission boundary' } };
        }] }] },
      },
    });
  } catch (error) {
    kill();
    const [cleanup] = await Promise.allSettled([dispose(), exit]);
    if (cleanup.status === 'rejected') throw new AggregateError([error, cleanup.reason], 'Source harness construction and cleanup failed');
    throw error;
  }
  closeRun = () => { run?.close(); };
  async function* lines(): AsyncIterable<string> {
    try {
      for await (const message of run ?? []) yield JSON.stringify(message);
      if (!disposed) code = 0;
    } finally { await dispose(); }
  }
  return { lines: lines(), errorText: () => errors, exit, signal: () => signal.aborted ? 'SIGTERM' : null, kill, dispose };
}
