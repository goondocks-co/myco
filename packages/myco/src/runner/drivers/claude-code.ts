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
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { jsonLines, numberOf, recordOf, startHarness, stringOf } from './stream.js';

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
 * There is nobody at a terminal to answer a permission prompt, and a `-p` turn
 * denies every tool it would have asked about, so a run on a machine whose own
 * mode asks is a run that calls nothing and ends its turn having done nothing.
 * The run's own server is allowed whole; the mode is the asking one, so the
 * machine's own `bypassPermissions` or `auto` does not reach a run queued from
 * elsewhere, and everything outside the run's server is refused.
 */
export const RUN_PERMISSIONS: readonly string[] = ['--permission-mode', 'default', '--allowedTools', `mcp__${MCP_SERVER_NAME}`];

/** A message's content blocks: an array of typed blocks, or one text block where the harness wrote a bare string. */
function blocksOf(message: Record<string, unknown> | null): Record<string, unknown>[] {
  const content = message?.content;
  if (Array.isArray(content)) return content.map(recordOf).filter((b): b is Record<string, unknown> => b !== null);
  const said = stringOf(content);
  return said === null ? [] : [{ type: 'text', text: said }];
}

export const claudeCodeDriver: Driver = {
  id: 'claude-code',
  async *run(spec: RunSpec, signal: AbortSignal): AsyncIterable<RunEvent> {
    const harness = harnessById('claude-code')!;
    const isolation = harness.isolation.kind === 'flag' ? harness.isolation.args : [];
    const started = startHarness(harness.binary, [
      '-p', spec.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', spec.mcpConfigPath,
      ...isolation,
      ...RUN_PERMISSIONS,
    ], { cwd: spec.scratchDir, env: spec.credentialEnv, signal });

    let ended = false;
    /** The tool each call id named, so a result can be read back as that call's outcome. */
    const calls = new Map<string, string>();
    for await (const line of jsonLines(started.lines)) {
      const type = stringOf(line.type);
      if (type === 'system' && stringOf(line.subtype) === 'init') {
        yield { kind: 'started', harness: harness.id, sessionId: stringOf(line.session_id) };
      } else if (type === 'system' && stringOf(line.subtype) === 'permission_denied') {
        yield { kind: 'tool_call', name: stringOf(line.tool_name) ?? 'tool', status: 'error' };
      } else if (type === 'assistant') {
        const failure = stringOf(line.error);
        if (failure !== null) { ended = true; yield { kind: 'ended', stop: 'error', detail: failure }; break; }
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
          const name = calls.get(stringOf(block.tool_use_id) ?? '') ?? 'tool';
          yield { kind: 'tool_call', name, status: block.is_error === true ? 'error' : 'ok' };
        }
      } else if (type === 'result') {
        const usage = recordOf(line.usage);
        yield {
          kind: 'usage',
          inputTokens: usage === null ? null : numberOf(usage.input_tokens),
          outputTokens: usage === null ? null : numberOf(usage.output_tokens),
          costUsd: numberOf(line.total_cost_usd),
        };
        ended = true;
        const stop = line.is_error === true ? 'error' : STOP[stringOf(line.stop_reason) ?? ''] ?? 'error';
        yield { kind: 'ended', stop, detail: stop === 'error' ? stringOf(line.terminal_reason) ?? stringOf(line.subtype) : null };
      }
    }
    const code = await started.exit;
    if (!ended) yield { kind: 'ended', stop: 'error', detail: `the harness wrote no result and exited ${code}: ${started.errorText().slice(0, 2000)}` };
  },
};
