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
import { jsonLines, numberOf, recordOf, startHarness, stringOf } from './stream.js';

const STOP: Readonly<Record<string, StopReason>> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  max_turns: 'max_turn_requests',
  refusal: 'refusal',
  cancelled: 'cancelled',
};

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
    ], { cwd: spec.scratchDir, env: spec.credentialEnv, signal });

    let ended = false;
    for await (const line of jsonLines(started.lines)) {
      const type = stringOf(line.type);
      if (type === 'system' && stringOf(line.subtype) === 'init') {
        yield { kind: 'started', harness: harness.id, sessionId: stringOf(line.session_id) };
      } else if (type === 'assistant') {
        const failure = stringOf(line.error);
        if (failure !== null) { ended = true; yield { kind: 'ended', stop: 'error', detail: failure }; break; }
        const message = recordOf(line.message);
        const said = message === null ? null : stringOf(message.content);
        if (said !== null) yield { kind: 'message', role: 'assistant', text: said };
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
