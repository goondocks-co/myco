/**
 * OpenCode, Cursor and Antigravity, over the agent protocol.
 *
 * A minimal client of the protocol's version 1 over the harness's own standard
 * input and output: `initialize`, then a session naming this run's MCP server,
 * then one prompt, then a stop reason, then close. Version 2 of the protocol
 * moves where a stop reason is delivered while keeping the same five values, so
 * the shape this driver answers is unchanged by it and only the read moves.
 *
 * Isolation here is best effort and the manifest says so: a session's servers
 * are added to whatever the harness already has, and a client cannot make its
 * own the only ones from outside. The airtight forms belong to the two harnesses
 * with native drivers.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { harnessById, type Harness } from '../harnesses.js';
import type { Driver, RunEvent, RunSpec, StopReason } from '../events.js';
import { MCP_SERVER_NAME } from '../mcp-config.js';

const STOP: readonly StopReason[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];

/** The command that makes this harness speak the protocol. */
function commandOf(harness: Harness): { command: string; args: readonly string[] } {
  if (harness.launch.kind === 'subcommand') return { command: harness.binary, args: harness.launch.args };
  if (harness.launch.kind === 'sidecar') return { command: harness.launch.binary, args: [] };
  return { command: harness.binary, args: [] };
}

/** One JSON-RPC connection over a child's pipes. */
class Connection {
  private held = '';
  private next = 1;
  private readonly waiting = new Map<number, (value: Record<string, unknown>) => void>();
  readonly updates: Array<Record<string, unknown>> = [];
  private drain: (() => void) | null = null;

  constructor(private readonly child: ReturnType<typeof spawn>) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { this.held += chunk; this.read(); });
  }

  private read(): void {
    let at = this.held.indexOf('\n');
    while (at >= 0) {
      const line = this.held.slice(0, at).trim();
      this.held = this.held.slice(at + 1);
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const id = typeof message.id === 'number' ? message.id : null;
          if (id !== null && this.waiting.has(id)) { this.waiting.get(id)!(message); this.waiting.delete(id); }
          else if (typeof message.method === 'string') { this.updates.push(message); this.drain?.(); }
        } catch { /* the harness writes prose beside the protocol; the protocol is what is read */ }
      }
      at = this.held.indexOf('\n');
    }
  }

  onUpdate(drain: () => void): void { this.drain = drain; }

  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

function serverOf(spec: RunSpec): Record<string, unknown> {
  const config = JSON.parse(readFileSync(spec.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  const server = config.mcpServers[MCP_SERVER_NAME]!;
  return {
    type: 'http',
    name: MCP_SERVER_NAME,
    url: server.url,
    headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
  };
}

export function acpDriver(id: string): Driver {
  return {
    id,
    async *run(spec: RunSpec, signal: AbortSignal): AsyncIterable<RunEvent> {
      const harness = harnessById(id)!;
      const { command, args } = commandOf(harness);
      const child = spawn(command, [...args], {
        cwd: spec.scratchDir,
        env: { ...process.env, ...spec.credentialEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let errors = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { errors += chunk; });
      const stop = (): void => { child.kill('SIGTERM'); };
      signal.addEventListener('abort', stop, { once: true });

      try {
        const connection = new Connection(child);
        await connection.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const session = await connection.call('session/new', { cwd: spec.scratchDir, mcpServers: [serverOf(spec)] });
        const sessionId = ((session.result ?? {}) as Record<string, unknown>).sessionId;
        yield { kind: 'started', harness: id, sessionId: typeof sessionId === 'string' ? sessionId : null };

        const answered = await connection.call('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: spec.prompt }],
        });
        for (const update of connection.updates) {
          const params = (update.params ?? {}) as Record<string, unknown>;
          const chunk = (params.update ?? {}) as Record<string, unknown>;
          const said = (chunk.content ?? {}) as Record<string, unknown>;
          if (typeof said.text === 'string' && said.text.length > 0) {
            yield { kind: 'message', role: chunk.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'assistant', text: said.text };
          }
        }
        const result = (answered.result ?? {}) as Record<string, unknown>;
        const reason = typeof result.stopReason === 'string' ? result.stopReason : '';
        const known = STOP.find((s) => s === reason) ?? null;
        yield known === null
          ? { kind: 'ended', stop: 'error', detail: `the harness answered no stop reason: ${errors.slice(0, 2000)}` }
          : { kind: 'ended', stop: known, detail: null };
        await connection.call('session/close', { sessionId });
      } finally {
        signal.removeEventListener('abort', stop);
        child.kill('SIGTERM');
      }
    },
  };
}
