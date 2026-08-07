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
 * THE SOCKET IS READ FROM THE RUNNING DAEMON, never from a hardcoded list. A
 * standalone `tailscaled` is started with its socket in argv, so asking the
 * process table finds the socket actually in use — including a non-default
 * path — and needs no vendor path baked into this codebase. The sandboxed
 * build runs no such process, which is exactly why it is not selected.
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
 */

/** How a standalone daemon names its control socket on the command line. */
const SOCKET_ARG = /--socket[= ]([^\s]+)/;

/** The daemon binary, as it appears in a process listing. */
const TAILSCALED_PROCESS = /(^|\/)tailscaled$/;

export interface TailscaleCliDeps {
  /** Test seam: the process table as `{ uid, command }` per running process. */
  processes?: () => Array<{ uid: number; command: string }>;
  /** Test seam. */
  exists?: (path: string) => boolean;
}

function defaultProcesses(): Array<{ uid: number; command: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    // `uid=` and `args=` with empty headers, so every line is `<uid> <argv...>`
    // on both macOS and Linux. `args` must come last — it contains spaces.
    return execFileSync('ps', ['-A', '-o', 'uid=', '-o', 'args='], { encoding: 'utf-8', timeout: 5_000 })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match = /^(\d+)\s+(.*)$/.exec(line);
        return match ? [{ uid: Number(match[1]), command: match[2]! }] : [];
      });
  } catch {
    return [];
  }
}

function defaultExists(target: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.existsSync(target);
  } catch {
    return false;
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
  const exists = deps.exists ?? defaultExists;
  for (const { uid, command } of (deps.processes ?? defaultProcesses)()) {
    // Root only — see the module docstring. This is the whole defence against
    // a planted socket, and the existence check below is none at all on its
    // own, since whoever planted the path also created the file.
    if (uid !== 0) continue;
    if (!TAILSCALED_PROCESS.test(command.split(/\s+/)[0] ?? '')) continue;
    const socket = SOCKET_ARG.exec(command)?.[1];
    if (socket && exists(socket)) return socket;
  }
  return null;
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
