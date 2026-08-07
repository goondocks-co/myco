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
 * Which local `tailscaled` Myco addresses.
 *
 * Measured on a real rig: a Mac running BOTH a Homebrew standalone daemon and
 * the App Store System Extension had two tailnet nodes, and the bare CLI
 * resolved to the sandboxed one. `myco host enable` then published a Funnel on
 * the node that cannot proxy to a unix socket, and the public URL 502'd. The
 * daemon, the socket and the admission gate were all working.
 */
import { describe, expect, test } from 'bun:test';

import { resolveTailscaleSocket, withTailscaleSocket } from '@myco/team-host/tailscale-cli';

describe('tailscale CLI socket selection', () => {
  /** Sockets exist, root-owned, 0o600 — the healthy shape. */
  const sockets = (paths: string[]) => (p: string) => (paths.includes(p) ? { uid: 0 } : null);

  /** A process table (root-owned unless stated) plus sockets that exist. */
  const rig = (commands: string[], paths: string[] = []) => ({
    processes: () => commands.map((command) => ({ uid: 0, command })),
    socketStat: sockets(paths),
    platform: 'darwin' as NodeJS.Platform,
  });
  /** The same, with every process owned by an unprivileged user. */
  const asUser = (commands: string[], paths: string[] = []) => ({
    processes: () => commands.map((command) => ({ uid: 501, command })),
    socketStat: sockets(paths),
    platform: 'darwin' as NodeJS.Platform,
  });

  const STANDALONE = '/opt/homebrew/bin/tailscaled --state=/x --socket=/var/run/tailscaled.socket --tun=userspace-networking';
  const SANDBOXED = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

  test('a single-Tailscale machine is left alone — no --socket', () => {
    // The CLI default IS that daemon. Injecting a path could only redirect a
    // working machine at something that may not exist.
    expect(resolveTailscaleSocket(rig([]))).toBeNull();
    expect(withTailscaleSocket(['funnel', 'status'], rig([]))).toEqual(['funnel', 'status']);
  });

  test('THE RIG CASE: both variants running → the standalone is chosen', () => {
    // Measured on a real Mac: two tailnet nodes, and the bare CLI resolved to
    // the sandboxed one, so `host enable` published a Funnel on the node that
    // cannot proxy to a unix socket. The daemon, socket and admission gate
    // were all working; only the daemon selection was wrong.
    const deps = rig([SANDBOXED, STANDALONE], ['/var/run/tailscaled.socket']);
    expect(resolveTailscaleSocket(deps)).toBe('/var/run/tailscaled.socket');
  });

  test('the sandboxed build ALONE selects nothing — it runs no such process', () => {
    expect(resolveTailscaleSocket(rig([SANDBOXED]))).toBeNull();
  });

  test('a NON-DEFAULT socket path is honoured', () => {
    // The point of reading the process table rather than a hardcoded list.
    const line = '/usr/sbin/tailscaled --socket=/opt/custom/ts.sock';
    expect(resolveTailscaleSocket(rig([line], ['/opt/custom/ts.sock']))).toBe('/opt/custom/ts.sock');
  });

  test('a daemon whose socket has VANISHED is not selected', () => {
    // A dead daemon's argv can outlive its socket; addressing a missing path
    // would break a machine the CLI default would have handled.
    expect(resolveTailscaleSocket(rig([STANDALONE], []))).toBeNull();
  });

  test('a Myco per-host daemon is not mistaken for the machine daemon', () => {
    // Nothing should match on a substring: only argv[0] naming the binary.
    const notADaemon = '/bin/grep --socket=/tmp/decoy.sock tailscaled';
    expect(resolveTailscaleSocket(rig([notADaemon], ['/tmp/decoy.sock']))).toBeNull();
  });

  test('the socket goes BEFORE the subcommand — tailscale rejects it after', () => {
    const deps = rig([STANDALONE], ['/var/run/tailscaled.socket']);
    const args = withTailscaleSocket(['funnel', '--https=8443', 'off'], deps);
    expect(args.indexOf('--socket')).toBe(0);
    expect(args.indexOf('funnel')).toBe(2);
  });

  test("the caller's argument array is not mutated", () => {
    const deps = rig([STANDALONE], ['/var/run/tailscaled.socket']);
    const original = ['funnel', 'status'];
    withTailscaleSocket(original, deps);
    expect(original).toEqual(['funnel', 'status']);
  });

  test('SECURITY: a NON-ROOT process advertising a socket is ignored', () => {
    // Every user's processes are in the process table. Without the uid check a
    // local user could run anything named `tailscaled` advertising
    // `--socket=/tmp/theirs.sock`, create that socket, and receive every
    // tailscale command Myco issues — including Funnel mutations. The
    // existence check is no defence: whoever planted the path made the file.
    const planted = '/tmp/evil/tailscaled --socket=/tmp/attacker.sock';
    expect(resolveTailscaleSocket(asUser([planted], ['/tmp/attacker.sock']))).toBeNull();
  });

  test('SECURITY: a planted process cannot preempt the REAL root daemon', () => {
    // The attacker's entry comes first in the table on purpose.
    const planted = '/tmp/evil/tailscaled --socket=/tmp/attacker.sock';
    const deps = {
      processes: () => [
        { uid: 501, command: planted },
        { uid: 0, command: STANDALONE },
      ],
      socketStat: sockets(['/tmp/attacker.sock', '/var/run/tailscaled.socket']),
      platform: 'darwin' as NodeJS.Platform,
    };
    expect(resolveTailscaleSocket(deps)).toBe('/var/run/tailscaled.socket');
  });

  test('a binary merely ENDING in tailscaled is not the daemon', () => {
    const wrapper = '/opt/notreally/tailscaled-wrapper --socket=/tmp/w.sock';
    expect(resolveTailscaleSocket(rig([wrapper], ['/tmp/w.sock']))).toBeNull();
  });

  test('the REAL socket mode (0666) is accepted — Tailscale ships it that way', () => {
    // Measured on a machine: `srw-rw-rw- root daemon /var/run/tailscaled.socket`.
    // Unprivileged users must reach the daemon for `tailscale status` to work,
    // so refusing a group/other-writable socket — the rule that guards an
    // EXEC'd runtime pin — rejects every legitimate daemon instead.
    const deps = {
      processes: () => [{ uid: 0, command: STANDALONE }],
      socketStat: () => ({ uid: 0 }),
      platform: 'darwin' as NodeJS.Platform,
    };
    expect(resolveTailscaleSocket(deps)).toBe('/var/run/tailscaled.socket');
  });

  test('SECURITY: a root process pointing at a NON-ROOT socket is refused', () => {
    const deps = {
      processes: () => [{ uid: 0, command: STANDALONE }],
      socketStat: () => ({ uid: 501 }),
      platform: 'darwin' as NodeJS.Platform,
    };
    expect(resolveTailscaleSocket(deps)).toBeNull();
  });

  test('AMBIGUITY: two root daemons naming DIFFERENT sockets resolves to null', () => {
    // Picking whichever the process table listed first is a silent wrong
    // answer half the time; null defers to the CLI default.
    const a = '/opt/homebrew/bin/tailscaled --socket=/var/run/a.sock';
    const b = '/usr/sbin/tailscaled --socket=/var/run/b.sock';
    expect(resolveTailscaleSocket(rig([a, b], ['/var/run/a.sock', '/var/run/b.sock']))).toBeNull();
  });

  test('the SAME socket named twice is not ambiguous', () => {
    // A daemon and a supervisor wrapper can both appear; one answer, not two.
    const dup = '/opt/homebrew/bin/tailscaled --socket=/var/run/tailscaled.socket';
    expect(resolveTailscaleSocket(rig([dup, dup], ['/var/run/tailscaled.socket'])))
      .toBe('/var/run/tailscaled.socket');
  });
});
