/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * The ONE owner of `tailscale` CLI invocation.
 *
 * Funnel is a Tailscale-cloud feature, so Myco necessarily drives the
 * operator's own Tailscale rather than a Myco-private one. That settles WHICH
 * TAILNET. It does not settle WHICH LOCAL DAEMON, and a machine can run more
 * than one:
 *
 *   - a standalone `tailscaled` process, which CAN proxy Funnel to a unix
 *     socket;
 *   - the macOS App Store / System Extension build, which accepts a
 *     unix-socket Funnel configuration and then cannot proxy to it — the
 *     public URL 502s with nothing in any log to say why.
 *
 * With both installed the bare CLI picks the sandboxed one, so Myco publishes
 * a URL on the node that cannot serve it. Choosing explicitly is this module's
 * whole job, and it happens HERE, once, rather than at each call site — a call
 * site re-deciding it has been a defect twice before (`tailscale up` and
 * `tailscale ip -4` both read the wrong tailnet), and the fix recorded then
 * was "one helper owning every invocation".
 *
 * THE SOCKET IS READ FROM THE RUNNING DAEMON, never from a hardcoded list, and
 * it is read TWO ways because one is not enough. A daemon told `--socket=…`
 * announces it in argv, so the process table finds it — including a non-default
 * path. A daemon told nothing runs on its own compiled-in default and argv is
 * silent, which is the ORDINARY install: a Homebrew `tailscaled` on macOS runs
 * as bare `/opt/homebrew/bin/tailscaled`, no arguments at all. Requiring argv to
 * name the socket made that daemon invisible, so selection returned null on
 * exactly the two-daemon Mac this module exists for, the CLI default chose the
 * sandboxed build, and the public URL went back to 502 — with every unit test
 * green, because each fixture spelled `--socket=` into its command string.
 *
 * For a daemon that names none, the open unix sockets of that PID are asked for
 * instead (`lsof -a -p <pid> -U`). That is still reading the socket off the
 * running daemon rather than guessing a path, so no vendor location is baked in
 * here — which matters beyond tidiness: pinning `/var/run/tailscale` would make
 * Myco reference a directory a vendor install owns, the coexistence rule meta
 * gate X4 enforces. Where `lsof` is absent the answer is null and the CLI
 * decides, the behaviour before this module existed.
 *
 * ONLY A ROOT-OWNED PROCESS IS TRUSTED, and that is load-bearing rather than
 * tidiness. Every user's processes appear in the process table, so without the
 * check any local user could run something named `tailscaled` advertising
 * `--socket=/tmp/theirs.sock`, create that socket, and have Myco address it —
 * handing them every subsequent tailscale command, including the Funnel
 * mutations and whatever `funnel status --json` discloses. A machine's
 * Tailscale daemon is a system service running as root, so requiring uid 0
 * excludes a forgery an unprivileged attacker can actually perform. A
 * user-owned daemon yields null, which falls back to the CLI default — the
 * behaviour before this module existed.
 *
 * THE SOCKET'S OWNER IS CHECKED TOO — it must be root — which a planted socket
 * cannot be. Its MODE deliberately is NOT: Tailscale ships the control socket
 * `srw-rw-rw-` (measured on a real machine) because unprivileged users have to
 * talk to the daemon, which is how `tailscale status` works at all. The
 * runtime-pin rule (`checkPinTrust`) refuses a group/other-writable file, but
 * that guards a binary we EXEC, where writability is the threat. Applying it
 * here rejects every legitimate daemon. What keeps the socket honest is that
 * `/var/run` is root-owned, so an unprivileged user cannot place an entry
 * there; a loose MODE lets them connect, not substitute.
 *
 * AMBIGUITY IS REFUSED. Two root daemons naming different sockets have no
 * right answer, and picking whichever the process table listed first is a
 * silent wrong answer half the time. Null sends the caller to the CLI default,
 * which is at least the behaviour they had.
 *
 * KNOWN LIMIT, stated because it is common: a legitimate USER-MODE standalone
 * `tailscaled` (rootless, `--tun=userspace-networking`) is not trusted either,
 * so on such a machine this module is inert and the CLI default decides. That
 * is the safe direction — a rootless daemon is indistinguishable from a
 * planted one — but it means the sandboxed-build disambiguation only takes
 * effect where `tailscaled` runs as root.
 */

/** How a standalone daemon names its control socket on the command line. */
const SOCKET_ARG = /--socket[= ]([^\s]+)/;

/** The daemon binary, as it appears in a process listing. */
const TAILSCALED_PROCESS = /(^|\/)tailscaled$/;

/** An lsof `-F n` name field holding an absolute path. A connected peer prints
 *  `n->0x…` instead, which is not a path and never matches. */
const LSOF_SOCKET_PATH = /^n(\/.+)$/;

export interface TailscaleCliDeps {
  /** Test seam: the process table as `{ uid, pid, command }` per running process. */
  processes?: () => Array<{ uid: number; pid: number; command: string }>;
  /** Test seam: the socket's owner uid, or null if absent. */
  socketStat?: (path: string) => { uid: number } | null;
  /** Test seam: the absolute unix-socket paths a PID holds open. */
  processSockets?: (pid: number) => string[];
  platform?: NodeJS.Platform;
}

function defaultProcesses(): Array<{ uid: number; pid: number; command: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    // Empty headers, so every line is `<uid> <pid> <argv...>` on both macOS and
    // Linux. `args` must come last — it contains spaces.
    return execFileSync('ps', ['-A', '-o', 'uid=', '-o', 'pid=', '-o', 'args='], { encoding: 'utf-8', timeout: 5_000 })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match ? [{ uid: Number(match[1]), pid: Number(match[2]), command: match[3]! }] : [];
      });
  } catch {
    return [];
  }
}

/**
 * The absolute unix-socket paths `pid` holds open, via `lsof`. Peer ENDPOINTS of
 * accepted connections print as `n->0x…` rather than a path and are excluded by
 * {@link LSOF_SOCKET_PATH}, so what survives is the bound path(s) — normally the
 * one control socket, repeated once per open descriptor.
 *
 * An empty array on any failure (no `lsof`, no permission, timeout): the caller
 * then contributes nothing for that daemon and selection falls back to the CLI
 * default, which is the safe direction.
 */
function defaultProcessSockets(pid: number): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-U', '-F', 'n'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(
      out.split('\n')
        .map((line) => LSOF_SOCKET_PATH.exec(line.trim())?.[1])
        .filter((p): p is string => Boolean(p)),
    )];
  } catch {
    return [];
  }
}

function defaultSocketStat(target: string): { uid: number } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    return { uid: fs.lstatSync(target).uid };
  } catch {
    return null;
  }
}

/**
 * The socket to address, or `null` to let the CLI choose.
 *
 * `null` is not a failure: it is the right answer on a machine running one
 * Tailscale, where the CLI's default IS that daemon. A path is returned only
 * when a running standalone daemon names one AND it exists, so this can only
 * make the selection more specific — never redirect a working machine at
 * something absent.
 */
export function resolveTailscaleSocket(deps: TailscaleCliDeps = {}): string | null {
  const stat = deps.socketStat ?? defaultSocketStat;
  const platform = deps.platform ?? process.platform;
  const posix = platform !== 'win32';
  const found = new Set<string>();

  const openSockets = deps.processSockets ?? defaultProcessSockets;

  for (const { uid, pid, command } of (deps.processes ?? defaultProcesses)()) {
    // Root only — see the module docstring. Existence alone is no defence:
    // whoever planted the path also created the file.
    if (uid !== 0) continue;
    if (!TAILSCALED_PROCESS.test(command.split(/\s+/)[0] ?? '')) continue;

    // A daemon that names no socket in argv is running on its compiled-in
    // default — the ordinary install, not an edge case — so ask the PROCESS
    // what it has open rather than guessing a path. A daemon holding more than
    // one bound path is as unanswerable as two daemons, and is skipped.
    const named = SOCKET_ARG.exec(command)?.[1];
    const open = named ? [named] : openSockets(pid);
    if (open.length !== 1) continue;
    const socket = open[0]!;

    const info = stat(socket);
    if (!info) continue;
    if (posix && info.uid !== 0) continue;
    found.add(socket);
  }

  // Exactly one answer, or none. Two root daemons naming different sockets is
  // a question this cannot answer, and guessing is worse than deferring.
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * Prepend the resolved `--socket` to a tailscale argument list.
 *
 * Separated from the spawn so the argument shape is testable without running
 * anything, and so a caller that owns its own spawn can adopt the selection
 * without inverting its control flow.
 */
export function withTailscaleSocket(args: readonly string[], deps: TailscaleCliDeps = {}): string[] {
  const socket = resolveTailscaleSocket(deps);
  return socket ? ['--socket', socket, ...args] : [...args];
}
