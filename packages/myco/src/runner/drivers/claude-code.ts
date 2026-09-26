import { claudeUsage } from './usage.js';
/**
 * Claude Code, driven natively.
 *
 * `--output-format stream-json` requires `--verbose` in print mode, and
 * `--strict-mcp-config` makes the run's own configuration the only source of
 * tools. `--bare` is not passed: it skips keychain reads, which is where this
 * harness keeps its login on macOS, so a run under it fails to authenticate on
 * a machine where the harness is logged in.
 *
 * Two shapes in this stream need care. The terminal `result` line carries
 * `structured_output` as a key that is present and null on an ordinary success,
 * so a reader that checks for the key rather than the value reads a value that
 * is not there. And a failed turn is reported in-band on an `assistant` line
 * with an `error` field while the process exits non-zero and still writes a
 * well-formed `result`; both are read.
 */
import { harnessById } from '../harnesses.js';
import type { Driver, RunEvent, RunSpec, StopReason } from '../events.js';
import { runGrant, grantsWhole } from './grant.js';
import { jsonLines, recordOf, startHarness, stringOf } from './stream.js';

const STOP: Readonly<Record<string, StopReason>> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  max_turns: 'max_turn_requests',
  refusal: 'refusal',
  cancelled: 'cancelled',
};

/**
 * The permissions a run holds, pinned rather than inherited.
 *
 * There is nobody at a terminal to answer a permission prompt, so nobody is
 * declared to answer one and every tool that would have asked is refused. The
 * mode is the asking one, so the machine's own `bypassPermissions` or `auto`
 * does not reach a queued run. What the run may call is its grant
 * (`grantOf`), passed as `--allowedTools`.
 */
export const RUN_PERMISSIONS: readonly string[] = ['--permission-mode', 'manual', '--permission-prompts', 'none'];

/**
 * The variable naming a script this harness sources before every shell
 * command, after the snapshot of the user's shell configuration, which sets
 * PATH as that configuration does.
 */
const SHELL_SETUP_VARIABLE = 'CLAUDE_ENV_FILE';

/** A message's content blocks. */
function blocksOf(message: Record<string, unknown> | null): Record<string, unknown>[] {
  const content = message?.content;
  return Array.isArray(content) ? content.map(recordOf).filter((b): b is Record<string, unknown> => b !== null) : [];
}

/** The calls a turn's result says were refused: the tool each named, and its call id where it carries one. */
function refusalsOf(result: Record<string, unknown>): { tool: string; id: string | null }[] {
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials : [];
  return denials.flatMap((d) => {
    const denial = recordOf(d);
    const tool = stringOf(denial?.tool_name);
    return tool === null ? [] : [{ tool, id: stringOf(denial?.tool_use_id) }];
  });
}

export const claudeCodeDriver: Driver = {
  id: 'claude-code',
  async *run(spec: RunSpec, signal: AbortSignal): AsyncIterable<RunEvent> {
    const harness = harnessById('claude-code')!;
    const isolation = harness.isolation.kind === 'flag' ? harness.isolation.args : [];
    const { rules: grant, env, shellSetup } = runGrant(spec);
    const started = startHarness(harness.binary, [
      '-p', spec.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', spec.mcpConfigPath,
      ...isolation,
      ...RUN_PERMISSIONS,
      '--allowedTools', ...grant,
    ], { cwd: spec.scratchDir, env: { ...spec.credentialEnv, ...env, ...(shellSetup === null ? {} : { [SHELL_SETUP_VARIABLE]: shellSetup }) }, signal });

    let ended = false;
    let failure: string | null = null;
    /** The tool each call id named, so a result can be read back as that call's outcome. */
    const calls = new Map<string, string>();
    /** Calls whose outcome has been reported: the harness reports a refusal on a system line, on the call's result and on the turn's result. */
    const reported = new Set<string>();
    /** Whether this is the first report of a call's outcome, recording it; a call with no id cannot be matched, so each of its reports is its own. */
    const firstReport = (id: string | null): boolean => {
      if (id === null) return true;
      if (reported.has(id)) return false;
      reported.add(id);
      return true;
    };
    for await (const line of jsonLines(started.lines)) {
      const type = stringOf(line.type);
      if (type === 'system' && stringOf(line.subtype) === 'init') {
        yield { kind: 'started', harness: harness.id, sessionId: stringOf(line.session_id) };
      } else if (type === 'system' && stringOf(line.subtype) === 'permission_denied') {
        if (firstReport(stringOf(line.tool_use_id))) yield { kind: 'tool_call', name: stringOf(line.tool_name) ?? 'tool', status: 'error' };
      } else if (type === 'assistant') {
        failure ??= stringOf(line.error);
        for (const block of blocksOf(recordOf(line.message))) {
          const kind = stringOf(block.type);
          if (kind === 'text') {
            const said = stringOf(block.text);
            if (said !== null) yield { kind: 'message', role: 'assistant', text: said };
          } else if (kind === 'tool_use') {
            const name = stringOf(block.name) ?? 'tool';
            const id = stringOf(block.id);
            if (id !== null) calls.set(id, name);
            yield { kind: 'tool_call', name, status: 'started' };
          }
        }
      } else if (type === 'user') {
        for (const block of blocksOf(recordOf(line.message))) {
          if (stringOf(block.type) !== 'tool_result') continue;
          const id = stringOf(block.tool_use_id);
          if (!firstReport(id)) continue;
          yield { kind: 'tool_call', name: (id === null ? undefined : calls.get(id)) ?? 'tool', status: block.is_error === true ? 'error' : 'ok' };
        }
      } else if (type === 'result') {
        yield { kind: 'usage', ...claudeUsage(line) };
        ended = true;
        // A refused call outside the grant is the harness keeping the run to
        // its tools, and is reported as that call's failure. A refusal of a
        // granted tool is the run kept from its own work, and ends the run.
        // The harness refuses a call of a tool held only by scoped rules when
        // the call is outside every one of them, so only a tool granted whole
        // is judged granted here.
        const refusals = refusalsOf(line);
        for (const { tool, id } of refusals) {
          if (firstReport(id)) yield { kind: 'tool_call', name: tool, status: 'error' };
        }
        const refused = refusals.filter(({ tool }) => grantsWhole(grant, tool)).map(({ tool }) => tool);
        if (refused.length > 0) { yield { kind: 'ended', stop: 'error', detail: `permission refused for ${[...new Set(refused)].join(', ')}` }; break; }
        const stop = failure !== null || line.is_error === true ? 'error' : STOP[stringOf(line.stop_reason) ?? ''] ?? 'error';
        yield { kind: 'ended', stop, detail: stop === 'error' ? failure ?? stringOf(line.terminal_reason) ?? stringOf(line.subtype) : null };
      }
    }
    const code = await started.exit;
    if (!ended) yield { kind: 'ended', stop: 'error', detail: failure ?? `the harness wrote no result and exited ${code}: ${started.errorText().slice(0, 2000)}` };
  },
};
