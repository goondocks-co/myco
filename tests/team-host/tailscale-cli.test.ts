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
  /** A process table plus the set of socket paths that exist on disk. */
  const rig = (processes: string[], sockets: string[] = []) => ({
    processes: () => processes,
    exists: (p: string) => sockets.includes(p),
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
});
