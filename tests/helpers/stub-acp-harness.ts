/**
 * A stub harness on PATH, for tests that need a worker to claim and drive a run
 * without a real agent installed.
 *
 * `cursor` is the harness whose login is probed by asking its binary rather than
 * by reading a file under the developer's home, so a script that exits 0 for
 * `status` is a logged-in harness and nothing outside the temporary directory is
 * touched. The same script answers the agent protocol for `acp`: initialize, a
 * session, one prompt that ends its turn, close.
 *
 * The protocol loop uses POSIX shell. Optional MCP verification pipes one
 * complete request to a separate JavaScript process with closed stdin.
 *
 * PATH is prepended and left that way — the directory holds this one script, and
 * a test that never spawns a harness is unaffected by its presence.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHarnesses, locate, type DetectedHarness } from '@myco/runner/detect.js';

/** The harness id a stub binary stands in for. */
export const STUB_HARNESS = 'cursor';

/** The binary that harness is detected by. */
const STUB_BINARY = 'cursor-agent';

/** How many 50 ms ticks a held turn waits to be released before ending anyway, so an abandoned stub is not a wedged one. */
const HOLD_TICKS = 1_200;

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The agent-protocol peer, in POSIX shell.
 *
 * Every request is answered with its own `id`: `session/new` names a session,
 * `session/prompt` ends its turn, `session/close` answers and exits, and
 * anything else — `initialize` among them — is answered an empty result, which
 * is all the driver reads from it. The id is the request's; no value the driver
 * sends carries an `"id":` key of its own, so reading the line's is unambiguous.
 *
 * A turn is held open by a file that does not exist yet, never by a delay: a
 * caller that wants to watch a run WHILE it is driven has to know the run is
 * still being driven when it looks, and a delay only makes that likely. How
 * likely depends on how long the caller's own reads take — against a Worker
 * under `wrangler dev` a single read is seconds — so a delay long enough on one
 * target is a race on another. The hold is bounded so a caller that dies leaves
 * no harness waiting forever.
 */
function peerScript(turnDelaySeconds: string, holdUntil: string, holdTicks: number, options: StubOptions): string {
  const mcpRead = options.mcpReceipt === undefined ? ''
    : `printf '%s\\n' "$line" | ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./stub-acp-mcp.mjs', import.meta.url)))} ${quote(options.mcpReceipt)} || exit 1; `;
  return [
    '#!/bin/sh',
    options.ignoreTermination === true ? "trap '' TERM" : '',
    '# The login probe is answered before anything else: detection asks the binary,',
    '# and a harness that is not logged in is offered by no worker.',
    'for arg in "$@"; do',
    '  if [ "$arg" = "status" ]; then exit 0; fi',
    'done',
    '',
    'reply() {',
    `  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$1" "$2"`,
    '}',
    '',
    'while IFS= read -r line; do',
    `  id=$(printf '%s\\n' "$line" | sed -n 's/.*"id":[ ]*\\([0-9][0-9]*\\).*/\\1/p')`,
    '  if [ -z "$id" ]; then continue; fi',
    '  case "$line" in',
    `    *'"session/new"'*) ${mcpRead}reply "$id" '{"sessionId":"sess_stub"}' ;;`,
    `    *'"session/prompt"'*)`,
    options.pidFile === undefined ? '' : `      printf '%s\\n' "$$" > ${quote(options.pidFile)}`,
    `      if [ "${turnDelaySeconds}" != "0" ]; then sleep ${turnDelaySeconds}; fi`,
    `      if [ -n ${quote(holdUntil)} ]; then`,
    '        waited=0',
    `        while [ ! -f ${quote(holdUntil)} ] && [ "$waited" -lt ${holdTicks} ]; do`,
    '          sleep 0.05',
    '          waited=$((waited + 1))',
    '        done',
    '      fi',
    options.ignoreTermination === true ? '      trap - TERM' : '',
    `      reply "$id" '{"stopReason":"end_turn"}' ;;`,
    `    *'"session/close"'*) reply "$id" '{}'; exit 0 ;;`,
    `    *) reply "$id" '{}' ;;`,
    '  esac',
    'done',
    '',
  ].join('\n');
}

/** What a stub harness is, as the thing under test sees it. */
export interface StubHarness {
  /** What detection makes of it. A worker's offer is built from this, so a caller asserts it before claiming. */
  detected: DetectedHarness;
  /** Whether the binary detection resolved is this stub rather than a real agent installed on the machine. */
  resolvedIsStub: boolean;
}

interface StubOptions {
  turnDelayMs?: number;
  holdUntil?: string;
  /** Ignore TERM while a held turn waits for its release file. */
  ignoreTermination?: boolean;
  /** Record the child PID so a test can wait for or terminate its own peer. */
  pidFile?: string;
  /** Save session material read through the MCP connection supplied by ACP. */
  mcpReceipt?: string;
}

/**
 * Put a stub `cursor-agent` on PATH and answer what detection makes of it.
 *
 * `holdUntil` names a file the turn waits for before it ends, so a caller
 * observes a run in flight because it has not released it yet rather than
 * because it looked in time. `turnDelayMs` is the blunt form, for the one case
 * that wants a turn nobody intends to release: a harness that never ends, which
 * is what a run budget is enforced against.
 *
 * Both facts are returned rather than assumed. `detected` says whether a worker
 * would offer the harness at all — a machine where it would not says so here
 * instead of leaving a test waiting on a run no worker can claim. And
 * `resolvedIsStub` says whether the binary found is THIS stub: a developer
 * machine with the real agent installed and logged in answers the probe from its
 * own PATH, so `detected` alone passes whether or not the stub was ever
 * reachable, and a probe that reads a stale environment would go unnoticed
 * everywhere except a machine without the real thing.
 */
export function stubAcpHarness(options: StubOptions = {}): StubHarness {
  const delay = options.turnDelayMs ?? 0;
  const dir = mkdtempSync(join(tmpdir(), 'myco-stub-acp-'));
  const binary = join(dir, STUB_BINARY);
  writeFileSync(binary, peerScript(delay === 0 ? '0' : (delay / 1000).toFixed(2), options.holdUntil ?? '', HOLD_TICKS, options), { mode: 0o755 });
  chmodSync(binary, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
  return {
    detected: detectHarnesses([STUB_HARNESS])[0] ?? { id: STUB_HARNESS, installed: false, authenticated: false },
    resolvedIsStub: locate(STUB_BINARY) === binary,
  };
}

/** What the stub must be for a worker to offer it, and that the stub is what was found. */
export const STUB_DETECTED: StubHarness = {
  detected: { id: STUB_HARNESS, installed: true, authenticated: true },
  resolvedIsStub: true,
};
