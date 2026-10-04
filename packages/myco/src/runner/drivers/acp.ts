import { accountingEvents } from '../accounting.js';
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
 *
 * Asking is not best effort. Each harness is started so that its own
 * configuration approves nothing in advance, as the manifest's `asking` says for
 * it: a run agent of the run's own, or a configuration directory of the run's
 * own. The run's grant then answers every call the harness makes.
 */
import { spawnGroup, stopGroup } from '../process-group.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { harnessById, type Harness } from '../harnesses.js';
import type { Driver, Launch, LaunchSpec, RunEvent, RunSpec, StopReason } from '../events.js';
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { AcpEvents } from './acp-events.js';
import { EFFORT_UNAPPLIED, PROFILE_UNAPPLIED } from '@goondocks/myco-shared/execution-profile';
import { applyProfile, optionsOf, type AnnouncedOptions } from './acp-profile.js';
import { answerPermission, ToolCalls } from './acp-permission.js';
import { runGrant, type RunGrant } from './grant.js';
import { listRunTools, type RunServer, type RunTools } from './run-tools.js';
import { freshRunHome } from './run-home.js';
import { heldStderr, launchEnvironment, recordOf, stringOf } from './stream.js';

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

/** What the agent a run starts in is named by, on a harness that asks only where its configuration says to. */
export const RUN_AGENT_PREFIX = 'myco-run';

/**
 * A name for a run's own agent that no other configuration can know in
 * advance. A harness merges configuration it fetches or finds after the run's,
 * and an agent it defines under the run's agent's name is merged into it; a
 * name drawn for this run alone is one nothing else defines.
 */
export function runAgentName(): string {
  return `${RUN_AGENT_PREFIX}-${randomBytes(8).toString('hex')}`;
}

/** The shell a run's commands run under: one that reads no startup file, so the run's environment is the one its commands see. */
const RUN_SHELL = '/bin/sh';

/**
 * The configuration a run-agent harness is given: an agent of the run's own,
 * named `agent`, the default, under which every call asks, and a shell that
 * reads no user startup file. Its permission comes after every rule the
 * harness's other configuration holds, and the last rule that matches a call
 * decides it. A refused call is that call's failure and not the end of the
 * agent's turn, so the agent goes on with the rest of its work. A claimed model
 * is the configuration's own model, which a session opens on where the harness
 * offers it, and its small model, so no part of the run falls to another; the
 * turn confirms it from the session before the prompt is sent.
 */
export function runAgentConfig(agent: string, platform: NodeJS.Platform = process.platform, profile?: RunSpec['profile']): Record<string, unknown> {
  return {
    default_agent: agent,
    ...(profile === undefined ? {} : { model: profile.model, small_model: profile.model }),
    ...(platform === 'win32' ? {} : { shell: RUN_SHELL }),
    experimental: { continue_loop_on_deny: true },
    agent: { [agent]: { mode: 'primary', description: 'A Myco run: every call is asked, and answered from the run\'s grant.', permission: { '*': 'ask' } } },
  };
}

/** The environment that makes a harness ask before every call, and the session mode that shows it will. */
export interface RunAsking {
  env: Record<string, string>;
  mode: string | null;
}

/**
 * How a run on this harness is made to ask: for a run-agent harness, the
 * run's own agent under a name drawn for it and the environment that keeps the
 * machine's extensions out. Every other harness needs nothing here.
 */
export function runAsking(harness: Harness | null, agent: string = runAgentName(), profile?: RunSpec['profile']): RunAsking {
  if (harness?.asking.kind !== 'run-agent') return { env: {}, mode: null };
  return { env: { ...harness.asking.extensionsOff, [harness.asking.env]: JSON.stringify(runAgentConfig(agent, process.platform, profile)) }, mode: agent };
}

/** The mode a session reports it started in: a configuration option named `mode`, or the protocol's own current mode. */
function sessionModeOf(info: Record<string, unknown>): string | null {
  const options = Array.isArray(info.configOptions) ? info.configOptions.map(recordOf) : [];
  const option = options.find((candidate) => candidate?.id === 'mode');
  return stringOf(option?.currentValue) ?? stringOf(recordOf(info.modes)?.currentModeId);
}

/** How long listing the run's tools may take before the run ends. */
export const RUN_TOOLS_TIMEOUT_MS = 15_000;

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
 * permission request naming one of them can be recognised; a run whose tools
 * cannot be listed ends there, since every call of them would be refused. A
 * session on a harness that asks only under the run's own agent must report
 * that agent as its mode, or the run ends before its prompt. A claimed profile
 * is applied to the session and confirmed from what it reports, or the run ends
 * before its prompt with the profile unapplied (`acp-profile.ts`). A permission
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
  listTools: (server: RunServer, signal: AbortSignal) => Promise<RunTools> = listRunTools,
  options: { grant?: RunGrant; signal?: AbortSignal; asking?: RunAsking } = {},
): AsyncIterable<RunEvent> {
  const harness = harnessById(id);
  const grant = options.grant ?? runGrant(spec, harness ?? { sourceGit: 'none' });
  const signal = options.signal ?? new AbortController().signal;
  const server = runServerOf(spec);
  const asking = options.asking ?? runAsking(harness);
  let tools: ReadonlySet<string> = new Set();
  let events: AcpEvents | undefined;
  let sessionId: string | null = null;
  /** The session's options as the agent last announced them in its own updates. */
  let announced: AnnouncedOptions = { count: 0, options: null };
  const calls = new ToolCalls();
  /** What the agent said, in the order it said it: its notifications, and the calls refused to it. */
  const said: Array<{ kind: 'update'; message: Record<string, unknown> } | { kind: 'refused'; toolCall: Record<string, unknown> }> = [];
  const connection = new Connection(channel, {
    request(method, params) {
      if (method !== REQUEST_PERMISSION) return methodNotFound(method);
      const toolCall = calls.merged(recordOf(params.toolCall) ?? {});
      const { outcome, refusal } = answerPermission(grant, tools, sessionId, params, toolCall, harness?.mycoCalls);
      if (refusal !== null && params.sessionId === sessionId) said.push({ kind: 'refused', toolCall });
      return { result: { outcome } };
    },
    notify(message) {
      const params = recordOf(message.params);
      const update = recordOf(params?.update);
      if (message.method === SESSION_UPDATE && sessionId !== null && params?.sessionId === sessionId && update !== null) {
        calls.saw(update);
        if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) announced = { count: announced.count + 1, options: optionsOf(update.configOptions) };
      }
      said.push({ kind: 'update', message });
    },
  });
  function* updates(): Iterable<RunEvent> {
    if (events === undefined || sessionId === null) return;
    for (const item of said.splice(0)) yield* item.kind === 'update' ? events.update(item.message, sessionId) : events.refused(item.toolCall);
  }
  try {
    const initialized = await connection.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const listed = await listTools(server, AbortSignal.any([signal, AbortSignal.timeout(RUN_TOOLS_TIMEOUT_MS)]));
    if (!listed.ok) {
      yield { kind: 'ended', stop: 'error', detail: `the run's tools could not be listed: ${listed.reason}`, code: 'tools_unlisted' };
      return;
    }
    tools = listed.names;
    const session = await connection.call('session/new', { cwd: spec.scratchDir, mcpServers: [acpServerOf(server)] });
    const refusedSession = recordOf(session.error);
    if (refusedSession !== null) {
      yield { kind: 'ended', stop: 'error', detail: `the harness refused the session: ${stringOf(refusedSession.message) ?? 'no reason given'} ${detailOnFailure()}`.trim() };
      return;
    }
    const info = recordOf(session.result) ?? {};
    sessionId = stringOf(info.sessionId);
    if (sessionId !== null) spec.sessionOpened?.(sessionId);
    const mode = sessionModeOf(info);
    if (asking.mode !== null && mode !== asking.mode) {
      yield { kind: 'ended', stop: 'error', detail: `the harness opened the session in mode ${mode ?? '(none)'} rather than the run's agent ${asking.mode}, so its calls would not be asked`, code: 'session_unasked' };
      return;
    }
    let reported = info;
    /** What the run's identity carries about how its profile was applied. */
    const warnings: string[] = [];
    if (spec.profile !== undefined) {
      const applied = await applyProfile((method, params) => connection.call(method, params), sessionId ?? '', info.configOptions, spec.profile, () => announced);
      if (!applied.ok) {
        yield { kind: 'ended', stop: 'error', detail: `${PROFILE_UNAPPLIED}: ${applied.detail}`, code: 'profile_unapplied', refusal: { code: PROFILE_UNAPPLIED, reason: applied.reason } };
        await connection.call('session/close', { sessionId }).catch(() => undefined);
        return;
      }
      reported = { ...info, configOptions: applied.configOptions };
      if (applied.effortUnapplied) warnings.push(EFFORT_UNAPPLIED);
    }
    events = new AcpEvents(id, stringOf(recordOf(recordOf(initialized.result)?.agentInfo)?.version), reported, undefined, warnings, tools);
    yield { kind: 'started', harness: id, sessionId };
    yield* events.identity();

    const answered = await connection.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: spec.prompt }] });
    yield* updates();
    const result = recordOf(answered.result) ?? {};
    yield* accountingEvents(() => [{ kind: 'usage', ...events!.usage(result) }]);
    const reason = typeof result.stopReason === 'string' ? result.stopReason : '';
    const known = STOP.find((s) => s === reason) ?? null;
    const answeredError = recordOf(answered.error);
    yield known !== null
      ? { kind: 'ended', stop: known, detail: null }
      : answeredError !== null
        ? { kind: 'ended', stop: 'error', detail: `the harness answered an error: ${stringOf(answeredError.message) ?? 'no reason given'} ${detailOnFailure()}`.trim() }
        : { kind: 'ended', stop: 'error', detail: `the harness answered no stop reason: ${detailOnFailure()}`, code: 'protocol_error' };
    await connection.call('session/close', { sessionId }).catch(() => undefined);
  } catch (error) {
    yield* updates();
    if (events !== undefined) yield* accountingEvents(() => [{ kind: 'usage', ...events!.usage({}) }]);
    yield error instanceof PeerClosed
      ? { kind: 'ended', stop: 'error', detail: `${error.message} ${detailOnFailure()}`.trim(), code: 'crashed' }
      : { kind: 'ended', stop: 'error', detail: String(error) };
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

/** Writes what a harness that reads a configuration directory of the run's own finds there. */
export type RunHomeWriter = (home: string) => void;

/**
 * The environment a run-home harness reads its configuration directory from,
 * with the directory written; nothing for any other harness. A run-home harness
 * whose driver was given no writer fails here, before the harness is started,
 * rather than being started over the machine's own configuration.
 */
function runHomeOf(harness: Harness, spec: LaunchSpec, writeHome: RunHomeWriter | undefined): Record<string, string> {
  if (harness.asking.kind !== 'run-home') return {};
  if (writeHome === undefined) throw new Error(`no run configuration is written for ${harness.id}, so its own would decide the run's calls`);
  const home = freshRunHome(spec.scratchDir, `${harness.id}-home`);
  writeHome(home);
  return { [harness.asking.env]: home };
}

/**
 * How the harness is started for a run or a listing: asking under a run agent of its own where it asks only where its
 * configuration says, a configuration directory of its own where it reads one, and the Deployment's credential.
 */
function acpLaunch(harness: Harness, spec: LaunchSpec, writeHome: RunHomeWriter | undefined): { launch: Launch; asking: RunAsking } {
  const asking = runAsking(harness, runAgentName(), spec.profile);
  return { asking, launch: { env: { ...spec.credentialEnv, ...asking.env, ...runHomeOf(harness, spec, writeHome) }, omitInherited: [] } };
}

export function acpDriver(id: string, writeHome?: RunHomeWriter): Driver {
  return {
    id,
    launch: (spec) => acpLaunch(harnessById(id)!, spec, writeHome).launch,
    async *run(spec: RunSpec, signal: AbortSignal): AsyncIterable<RunEvent> {
      const harness = harnessById(id)!;
      const { command, args } = commandOf(harness);
      const grant = runGrant(spec, harness);
      let launched: { launch: Launch; asking: RunAsking };
      try { launched = acpLaunch(harness, spec, writeHome); } catch (error) {
        yield { kind: 'ended', stop: 'error', detail: error instanceof Error ? error.message : String(error), code: 'launch_failed' };
        return;
      }
      const { launch, asking } = launched;
      const child = spawnGroup(command, args, {
        cwd: spec.scratchDir,
        env: launchEnvironment({ ...launch.env, ...grant.env }, launch.omitInherited),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let errors = '';
      const exited: { status: { exitCode: number | null; signal: string | null } | null } = { status: null };
      child.once('close', (code, signal) => { exited.status = { exitCode: code, signal }; });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { errors = heldStderr(errors, chunk); });
      const stop = (): void => { void stopGroup(child); };
      signal.addEventListener('abort', stop, { once: true });
      // A write to a harness that has exited fails on its stdin; the exit itself
      // closes the connection, and the failed write is kept with its diagnostics.
      child.stdin?.on('error', (error) => { errors = heldStderr(errors, `\nwriting to the harness failed: ${error.message}`); });
      child.stdout?.setEncoding('utf8');
      const channel: Channel = {
        write: (line) => { child.stdin?.write(line); },
        onLine: (read) => { child.stdout?.on('data', (chunk: string) => { read(chunk); }); },
        onClose: (closed) => { child.once('close', closed); child.once('error', closed); },
      };
      try {
        // A harness that went away mid-turn ends with the status its process exited with.
        for await (const event of turnOver(channel, id, spec, () => errors, listRunTools, { grant, signal, asking })) {
          yield event.kind === 'ended' && event.code === 'crashed' && exited.status !== null ? { ...event, ...exited.status } : event;
        }
      } finally {
        signal.removeEventListener('abort', stop);
        void stopGroup(child);
      }
    },
  };
}
