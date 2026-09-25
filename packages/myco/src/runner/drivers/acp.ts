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
import { AcpEvents } from './acp-events.js';
import { answerPermission, ToolCalls } from './acp-permission.js';
import { grantOf } from './grant.js';
import { listRunTools, type RunServer, type RunTools } from './run-tools.js';
import { recordOf, stringOf } from './stream.js';

const STOP: readonly StopReason[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];

/** The command that makes this harness speak the protocol. */
function commandOf(harness: Harness): { command: string; args: readonly string[] } {
  if (harness.launch.kind === 'subcommand') return { command: harness.binary, args: harness.launch.args };
  if (harness.launch.kind === 'sidecar') return { command: harness.launch.binary, args: [] };
  return { command: harness.binary, args: [] };
}

/** What a connection writes to and reads from: a child's pipes, or a peer a test provides. */
export interface Channel {
  write(line: string): void;
  onLine(read: (line: string) => void): void;
  onClose(closed: () => void): void;
}

/** A call that will never be answered: the peer went away mid-call. */
export class PeerClosed extends Error {
  constructor(readonly detail: string) { super(`the harness closed the connection: ${detail}`); }
}

/** The JSON-RPC error code for a method this client does not implement. */
const METHOD_NOT_FOUND = -32601;

/** What this client answers a request the agent makes of it. */
export type Answer = { result: Record<string, unknown> } | { error: { code: number; message: string } };

/** A method this client does not implement, answered so the agent does not wait on it. */
function methodNotFound(method: string): Answer {
  return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
}

/** What the agent sends that is not an answer to this client's own calls. */
export interface Inbound {
  /** A request the agent makes of this client, answered at once. */
  request(method: string, params: Record<string, unknown>): Answer;
  /** A notification, which takes no answer. */
  notify(message: Record<string, unknown>): void;
}

/** A JSON-RPC request id: the agent's own, answered with the same value. */
const isRequestId = (id: unknown): id is string | number => typeof id === 'string' || typeof id === 'number';

/**
 * One JSON-RPC connection to an agent peer.
 *
 * The client's calls and the agent's requests are numbered by their own
 * senders, so the same id can name both at once. A message carrying a method is
 * the agent's, whatever its id, and only a message without one answers a call.
 *
 * Every pending call is rejected when the peer closes, so a harness that dies
 * mid-turn ends the run with what it said rather than leaving the worker
 * waiting on an answer that cannot come.
 */
export class Connection {
  private held = '';
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private closed: PeerClosed | null = null;

  constructor(private readonly channel: Channel, private readonly inbound: Inbound) {
    channel.onLine((chunk) => { this.held += chunk; this.read(); });
    channel.onClose(() => {
      this.closed = new PeerClosed('it wrote no answer');
      for (const pending of this.waiting.values()) pending.reject(this.closed);
      this.waiting.clear();
    });
  }

  private read(): void {
    let at = this.held.indexOf('\n');
    while (at >= 0) {
      const line = this.held.slice(0, at).trim();
      this.held = this.held.slice(at + 1);
      if (line.length > 0) {
        let message: Record<string, unknown> | null = null;
        try { message = recordOf(JSON.parse(line)); } catch { /* a harness writes prose beside the protocol; the protocol is what is read */ }
        if (message !== null) this.receive(message);
      }
      at = this.held.indexOf('\n');
    }
  }

  private receive(message: Record<string, unknown>): void {
    const { id, method } = message;
    if (typeof method === 'string') {
      if (isRequestId(id)) this.send({ id, ...this.inbound.request(method, recordOf(message.params) ?? {}) });
      else this.inbound.notify(message);
    } else if (typeof id === 'number') {
      const pending = this.waiting.get(id);
      if (pending === undefined) return;
      this.waiting.delete(id);
      pending.resolve(message);
    }
  }

  private send(message: Record<string, unknown>): void {
    this.channel.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed !== null) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
}

/** The one request this client implements. */
const REQUEST_PERMISSION = 'session/request_permission';

/** The notification that carries the session's updates. */
const SESSION_UPDATE = 'session/update';

/**
 * One turn over an agent peer: a session naming this run's server, a prompt,
 * and the stop reason the turn ended on. Written against a channel rather than
 * a process so a peer can answer it without one.
 *
 * The tools the run's server serves are listed before the session opens, so a
 * permission request naming one of them can be recognised. A permission
 * request is answered from the run's grant as it arrives. A call refused
 * outside the grant is that call's failure, never the run's: the turn ends on
 * the agent's own stop reason. Every other request is answered as a method this
 * client does not implement.
 */
export async function* turnOver(
  channel: Channel,
  id: string,
  spec: RunSpec,
  detailOnFailure: () => string,
  listTools: (server: RunServer) => Promise<RunTools> = listRunTools,
): AsyncIterable<RunEvent> {
  const grant = grantOf(spec);
  const server = runServerOf(spec);
  let tools: RunTools = { ok: false, reason: 'the run\'s tools were not listed before the session opened' };
  let events: AcpEvents | undefined;
  let sessionId: string | null = null;
  const calls = new ToolCalls();
  /** What the agent said, in the order it said it: its notifications, and the calls refused to it. */
  const said: Array<{ kind: 'update'; message: Record<string, unknown> } | { kind: 'refused'; toolCall: Record<string, unknown>; detail: string }> = [];
  const connection = new Connection(channel, {
    request(method, params) {
      if (method !== REQUEST_PERMISSION) return methodNotFound(method);
      const toolCall = calls.merged(recordOf(params.toolCall) ?? {});
      const { outcome, refusal } = answerPermission(grant, tools, sessionId, params, toolCall);
      if (refusal !== null && params.sessionId === sessionId) said.push({ kind: 'refused', toolCall, detail: refusal });
      return { result: { outcome } };
    },
    notify(message) {
      const params = recordOf(message.params);
      const update = recordOf(params?.update);
      if (message.method === SESSION_UPDATE && sessionId !== null && params?.sessionId === sessionId && update !== null) calls.saw(update);
      said.push({ kind: 'update', message });
    },
  });
  function* updates(): Iterable<RunEvent> {
    if (events === undefined || sessionId === null) return;
    for (const item of said.splice(0)) yield* item.kind === 'update' ? events.update(item.message, sessionId) : events.refused(item.toolCall, item.detail);
  }
  try {
    const initialized = await connection.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    tools = await listTools(server);
    const session = await connection.call('session/new', { cwd: spec.scratchDir, mcpServers: [acpServerOf(server)] });
    const info = recordOf(session.result) ?? {};
    sessionId = stringOf(info.sessionId);
    events = new AcpEvents(id, stringOf(recordOf(recordOf(initialized.result)?.agentInfo)?.version), info);
    yield { kind: 'started', harness: id, sessionId };

    const answered = await connection.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: spec.prompt }] });
    yield* updates();
    const result = recordOf(answered.result) ?? {};
    yield { kind: 'usage', ...events.usage(result) };
    const reason = typeof result.stopReason === 'string' ? result.stopReason : '';
    const known = STOP.find((s) => s === reason) ?? null;
    yield known === null
      ? { kind: 'ended', stop: 'error', detail: `the harness answered no stop reason: ${detailOnFailure()}` }
      : { kind: 'ended', stop: known, detail: null };
    await connection.call('session/close', { sessionId }).catch(() => undefined);
  } catch (error) {
    yield* updates();
    if (events !== undefined) yield { kind: 'usage', ...events.usage({}) };
    yield { kind: 'ended', stop: 'error', detail: error instanceof PeerClosed ? `${error.message} ${detailOnFailure()}`.trim() : String(error) };
  }
}

/** The run's server, as its MCP configuration names it. */
function runServerOf(spec: RunSpec): RunServer {
  const config = JSON.parse(readFileSync(spec.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, RunServer> };
  const { url, headers } = config.mcpServers[MCP_SERVER_NAME]!;
  return { url, headers };
}

/** The run's server, as a session names it to the agent. */
function acpServerOf(server: RunServer): Record<string, unknown> {
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
      // A write to a harness that has exited fails on its stdin; the exit itself
      // closes the connection, and the failed write is kept with its diagnostics.
      child.stdin?.on('error', (error) => { errors += `\nwriting to the harness failed: ${error.message}`; });
      child.stdout?.setEncoding('utf8');
      const channel: Channel = {
        write: (line) => { child.stdin?.write(line); },
        onLine: (read) => { child.stdout?.on('data', (chunk: string) => { read(chunk); }); },
        onClose: (closed) => { child.once('close', closed); child.once('error', closed); },
      };
      try {
        yield* turnOver(channel, id, spec, () => errors.slice(0, 2000));
      } finally {
        signal.removeEventListener('abort', stop);
        child.kill('SIGTERM');
      }
    },
  };
}
