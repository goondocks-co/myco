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
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { harnessById } from '../harnesses.js';
import type { Driver, RunEvent, RunSpec, StopReason } from '../events.js';
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { RUN_REPOSITORY_DIR, SOURCE_GIT_READ_COMMANDS } from '@goondocks/myco-shared/repository';
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
 * run's own server is allowed whole; the mode is the asking one, so the
 * machine's own `bypassPermissions` or `auto` does not reach a queued run.
 * Source runs additionally allow file reads and bounded Git history commands.
 */
export const RUN_PERMISSIONS: readonly string[] = ['--permission-mode', 'manual', '--permission-prompts', 'none', '--allowedTools', `mcp__${MCP_SERVER_NAME}`];

/** Source runs can inspect files and repository history without approving writes. */
function sourceReadTools(scratchDir: string): string[] {
  const root = join(scratchDir, RUN_REPOSITORY_DIR);
  const paths = [...new Set([RUN_REPOSITORY_DIR, root, realpathSync(root)])];
  const prefixes = ['git', ...paths.map((path) => `git -C ${path}`)];
  return ['Read', 'Glob', 'Grep', ...prefixes.flatMap((prefix) => SOURCE_GIT_READ_COMMANDS.map((command) => `Bash(${prefix} ${command}:*)`))];
}

/** A message's content blocks. */
function blocksOf(message: Record<string, unknown> | null): Record<string, unknown>[] {
  const content = message?.content;
  return Array.isArray(content) ? content.map(recordOf).filter((b): b is Record<string, unknown> => b !== null) : [];
}

/** The tools a turn's result says were refused, by name. */
function deniedTools(result: Record<string, unknown>): string[] {
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials : [];
  return denials.map((d) => stringOf(recordOf(d)?.tool_name)).filter((n): n is string => n !== null);
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
      ...(spec.sourceReadOnly === true ? sourceReadTools(spec.scratchDir) : []),
    ], { cwd: spec.scratchDir, env: spec.credentialEnv, signal });

    let ended = false;
    let failure: string | null = null;
    /** The tool each call id named, so a result can be read back as that call's outcome. */
    const calls = new Map<string, string>();
    /** Calls already reported as refused: the harness says so twice, on a system line and on the result. */
    const denied = new Set<string>();
    for await (const line of jsonLines(started.lines)) {
      const type = stringOf(line.type);
      if (type === 'system' && stringOf(line.subtype) === 'init') {
        yield { kind: 'started', harness: harness.id, sessionId: stringOf(line.session_id) };
      } else if (type === 'system' && stringOf(line.subtype) === 'permission_denied') {
        const id = stringOf(line.tool_use_id);
        if (id !== null) denied.add(id);
        yield { kind: 'tool_call', name: stringOf(line.tool_name) ?? 'tool', status: 'error' };
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
          const id = stringOf(block.tool_use_id) ?? '';
          if (denied.has(id)) continue;
          yield { kind: 'tool_call', name: calls.get(id) ?? 'tool', status: block.is_error === true ? 'error' : 'ok' };
        }
      } else if (type === 'result') {
        yield { kind: 'usage', ...claudeUsage(line) };
        ended = true;
        // A turn the harness calls a success while it refused the run's own
        // tools is the run doing nothing; the refusals are its outcome.
        const refused = deniedTools(line);
        if (refused.length > 0) { yield { kind: 'ended', stop: 'error', detail: `permission refused for ${[...new Set(refused)].join(', ')}` }; break; }
        const stop = failure !== null || line.is_error === true ? 'error' : STOP[stringOf(line.stop_reason) ?? ''] ?? 'error';
        yield { kind: 'ended', stop, detail: stop === 'error' ? failure ?? stringOf(line.terminal_reason) ?? stringOf(line.subtype) : null };
      }
    }
    const code = await started.exit;
    if (!ended) yield { kind: 'ended', stop: 'error', detail: failure ?? `the harness wrote no result and exited ${code}: ${started.errorText().slice(0, 2000)}` };
  },
};
