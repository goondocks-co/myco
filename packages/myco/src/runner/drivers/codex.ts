/**
 * Codex, driven natively.
 *
 * `--json` writes one event per line and `turn.completed` is the terminal one,
 * carrying the turn's own token counts. Two shapes need care. An `error` item
 * arrives in the same stream as ordinary items and does **not** end the turn or
 * change the exit status, so treating one as a failure would fail runs that
 * completed. And the harness reads standard input even when given a prompt, so
 * the child's stdin is closed rather than left open.
 *
 * Isolation is a redirected configuration home rather than a flag: naming MCP
 * servers on the command line adds them to the servers the host already
 * configured, and a run's tools must be the run's alone.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessById } from '../harnesses.js';
import type { Driver, RunEvent, RunSpec } from '../events.js';
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { jsonLines, numberOf, recordOf, startHarness, stringOf } from './stream.js';

/** The run's MCP server, in the configuration language this harness reads, inside a home of its own. */
function configHome(spec: RunSpec): string {
  const home = join(spec.scratchDir, 'codex-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // The run's connection is authored once, in `mcp-config.ts`. This reads that
  // file and restates it in the language this harness configures servers in,
  // rather than naming the server, the URL or the headers a second time.
  const config = JSON.parse(readFileSync(spec.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  const server = config.mcpServers[MCP_SERVER_NAME]!;
  const headers = Object.entries(server.headers).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join('\n');
  writeFileSync(join(home, 'config.toml'),
    `[mcp_servers.${MCP_SERVER_NAME}]\nurl = ${JSON.stringify(server.url)}\n\n[mcp_servers.${MCP_SERVER_NAME}.http_headers]\n${headers}\n`,
    { mode: 0o600 });
  return home;
}

export const codexDriver: Driver = {
  id: 'codex',
  async *run(spec: RunSpec, signal: AbortSignal): AsyncIterable<RunEvent> {
    const harness = harnessById('codex')!;
    const home = configHome(spec);
    const env = { ...spec.credentialEnv, ...(harness.isolation.kind === 'home' ? { [harness.isolation.env]: home } : {}) };
    const started = startHarness(harness.binary, ['exec', '--json', '--skip-git-repo-check', spec.prompt], { cwd: spec.scratchDir, env, signal });

    let ended = false;
    for await (const line of jsonLines(started.lines)) {
      const type = stringOf(line.type);
      if (type === 'thread.started') {
        yield { kind: 'started', harness: harness.id, sessionId: stringOf(line.thread_id) };
      } else if (type === 'item.completed') {
        const item = recordOf(line.item);
        const itemType = item === null ? null : stringOf(item.type);
        // An error item is one item among many and never the end of the turn.
        if (itemType === 'agent_message') yield { kind: 'message', role: 'assistant', text: stringOf(item?.text) ?? '' };
        else if (itemType === 'error') yield { kind: 'tool_call', name: 'item', status: 'error' };
      } else if (type === 'turn.completed') {
        const usage = recordOf(line.usage);
        yield {
          kind: 'usage',
          inputTokens: usage === null ? null : numberOf(usage.input_tokens),
          outputTokens: usage === null ? null : numberOf(usage.output_tokens),
          costUsd: null,
        };
        ended = true;
        yield { kind: 'ended', stop: 'end_turn', detail: null };
      } else if (type === 'turn.failed') {
        ended = true;
        yield { kind: 'ended', stop: 'error', detail: stringOf(recordOf(line.error)?.message) };
      }
    }
    const code = await started.exit;
    if (!ended) yield { kind: 'ended', stop: 'error', detail: `the harness completed no turn and exited ${code}: ${started.errorText().slice(0, 2000)}` };
  },
};
