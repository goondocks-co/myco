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
 * configured, and a run's tools must be the run's alone. The redirect is
 * additive over the machine's own home rather than a replacement of it, because
 * that home holds the login as well as the configuration: a home holding only
 * the run's server is a run with no login, and the harness fails its turn on a
 * 401 from the model's API on a machine that is signed in.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify, type TomlTableWithoutBigInt } from 'smol-toml';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { credentialFile, harnessById, type Harness } from '../harnesses.js';
import type { Driver, RunEvent, RunSpec } from '../events.js';
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { jsonLines, numberOf, recordOf, startHarness, stringOf } from './stream.js';

/** The table every MCP server this harness reads is declared under. */
const MCP_TABLE = 'mcp_servers';
/** The variable a Deployment hands this harness's key in. */
const CREDENTIAL_VARIABLE = HARNESS_CREDENTIALS.codex.variables[0]!;
/** The field this harness reads a key from in its login file, which is the only form it takes one in. */
const LOGIN_KEY_FIELD = 'OPENAI_API_KEY';

/**
 * What the run signs in as, in the home the run reads.
 *
 * A Deployment that holds a key for this harness is the run's login, and it has
 * to be written as a login: this harness reads a key from its login file and
 * not from the environment, so a key left in the environment alone signs
 * nothing in. The machine's own login is carried only where the Deployment
 * holds none — that slot is shared, so a Deployment holding a key for something
 * else entirely would otherwise take a signed-in machine's runs away from it.
 *
 * The machine's login is linked rather than copied: this harness writes its
 * login file in place, so a token it refreshes lands in the file the machine
 * signs in with rather than in a copy this then deletes, and no second copy of
 * a credential is written for anything to read.
 */
function carryLogin(home: string, spec: RunSpec, harness: Harness): void {
  const key = spec.credentialEnv[CREDENTIAL_VARIABLE];
  if (key !== undefined && key !== '') {
    writeFileSync(join(home, 'auth.json'), `${JSON.stringify({ [LOGIN_KEY_FIELD]: key }, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  const login = credentialFile(harness);
  if (login !== null && existsSync(login)) symlinkSync(login, join(home, 'auth.json'));
}

/**
 * The configuration the run reads: the machine's own, with the run's MCP server
 * in place of every other and the two settings a queued run cannot inherit.
 *
 * What the operator set is what a run on their machine behaves under, and it is
 * carried as it stands — `[model_providers]` and the headers one can hold
 * included, into a directory only the worker's user can read. Their servers are
 * the exception: a run's tools are the run's alone, and a server the operator
 * configured carries the operator's own headers besides.
 *
 * Two settings are the run's rather than the machine's. There is nobody at a
 * terminal to answer an approval, so a run that asked for one would hang until
 * its budget ended it. And a run queued from elsewhere is bounded by its own
 * directory, rather than by what an operator allows themselves sitting in front
 * of the machine — `danger-full-access` on a laptop is a setting for the person
 * holding it.
 *
 * It is read and written through a parser: this file is the operator's, and a
 * scan for the lines that look like server declarations mistakes a multi-line
 * string that contains one for the real thing.
 */
function runConfig(spec: RunSpec, harness: Harness): string {
  const login = credentialFile(harness);
  // A harness keeps its login inside its configuration home, so the directory
  // holding the declared login file is the home this run is additive over.
  const machinePath = login === null ? null : join(dirname(login), 'config.toml');
  const machine = (machinePath !== null && existsSync(machinePath)
    ? parse(readFileSync(machinePath, 'utf8'))
    : {}) as Record<string, unknown>;
  machine.approval_policy = 'never';
  machine.sandbox_mode = spec.sourceReadOnly === true ? 'read-only' : 'workspace-write';

  // The run's connection is authored once, in `mcp-config.ts`. This reads that
  // file and restates it in the language this harness configures servers in,
  // rather than naming the server, the URL or the headers a second time.
  const config = JSON.parse(readFileSync(spec.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  const server = config.mcpServers[MCP_SERVER_NAME]!;
  // Every server the machine declared, under a header or at the root, is one
  // value under one key: the run's server replaces the lot rather than joining it.
  machine[MCP_TABLE] = { [MCP_SERVER_NAME]: { url: server.url, http_headers: server.headers } };
  return stringify(machine as TomlTableWithoutBigInt);
}

/**
 * The configuration home a run reads, built where the run's own files are.
 *
 * The directory belongs to the run and goes when the run does, so what the
 * harness writes beside its configuration — sessions, history, logs — is the
 * run's and never the machine's. It is built from nothing on every attempt: a
 * worker killed mid-run leaves a home behind, and the run it belongs to is
 * claimed again under the same id.
 */
function runHome(spec: RunSpec, harness: Harness): string {
  const home = join(spec.scratchDir, 'codex-home');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  carryLogin(home, spec, harness);
  writeFileSync(join(home, 'config.toml'), runConfig(spec, harness), { mode: 0o600 });
  return home;
}

/** A tool call's outcome in the driver's words: Codex says `completed` and `failed`, and anything else is a call still going. */
function toolStatus(status: string | null): 'started' | 'ok' | 'error' {
  return status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'started';
}

export const codexDriver: Driver = {
  id: 'codex',
  async *run(spec: RunSpec, signal: AbortSignal): AsyncIterable<RunEvent> {
    const harness = harnessById('codex')!;
    const home = runHome(spec, harness);
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
        else if (itemType === 'mcp_tool_call') yield { kind: 'tool_call', name: stringOf(item?.tool) ?? 'mcp', status: toolStatus(stringOf(item?.status)) };
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
