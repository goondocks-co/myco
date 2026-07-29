/**
 * X5 — the overlay forward's lifecycle (Overlay Coexistence spec §8.1/§8.2).
 *
 * The forward is persistent, out-of-process exposure: tailscaled keeps it
 * across its own restarts (measured on the rig), so a forward pointing at a
 * port this daemon no longer holds delivers member requests — bearer tokens
 * included — to whatever binds that port next. These tests pin the three
 * behaviours that bound that window.
 *
 * The fake CLI reproduces tailscale's ACTUAL observed behaviour, captured from
 * a live headscale + userspace-tailscaled rig rather than assumed:
 *   · `serve status --json` on an unconfigured node prints `{}` — with NO
 *     `TCP` key at all, not an empty object.
 *   · a configured node prints `{"TCP":{"41443":{"TCPForward":"127.0.0.1:41443"}}}`.
 *   · `serve --tcp=<port> off` for a port with no forward exits NON-ZERO with
 *     "serve config does not exist" — the ordinary clean-shutdown case.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

import {
  isPortHeld,
  readServeTcpPorts,
  reconcileOverlayForward,
  retireOverlayForward,
} from '@myco/daemon/overlay-forward.js';
import type { TailscaleCli } from '@myco/host/tailscale-cli.js';

/** A fake tailscale CLI over an in-memory serve config. */
function fakeCli(initialPorts: number[] = []): { cli: TailscaleCli; calls: string[][]; ports: Set<number> } {
  const ports = new Set(initialPorts);
  const calls: string[][] = [];
  const cli: TailscaleCli = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'serve' && args[1] === 'status') {
        // Absent TCP key when nothing is configured — the real shape.
        const body = ports.size === 0
          ? '{}'
          : JSON.stringify({
            TCP: Object.fromEntries(
              [...ports].map((p) => [String(p), { TCPForward: `127.0.0.1:${p}` }]),
            ),
          });
        return { stdout: body, exitCode: 0 };
      }
      const off = args.find((a) => a === 'off');
      const tcpFlag = args.find((a) => a.startsWith('--tcp='));
      const port = tcpFlag ? Number(tcpFlag.slice('--tcp='.length)) : NaN;
      if (off) {
        if (!ports.has(port)) {
          return { stdout: 'error: failed to remove TCP serve: serve config does not exist', exitCode: 1 };
        }
        ports.delete(port);
        return { stdout: '', exitCode: 0 };
      }
      ports.add(port);
      return { stdout: 'Serve started and running in the background.', exitCode: 0 };
    },
    async overlayIp() { return null; },
  };
  return { cli, calls, ports };
}

describe('isPortHeld', () => {
  it('reports a bound port as held', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;

    expect(await isPortHeld(port)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('reports a free port as not held, and does not leave it occupied', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));

    expect(await isPortHeld(port)).toBe(false);
    // The probe must release the port it briefly bound, or it becomes the
    // squatter it exists to detect.
    const after = net.createServer();
    await new Promise<void>((r) => after.listen(port, '127.0.0.1', () => r()));
    await new Promise<void>((r) => after.close(() => r()));
  });

  // NOTE — deliberately NOT tested here: that the probe keeps working when
  // `lsof`/`ss` is missing. The obvious test (mutate PATH, assert the answer is
  // still right) does not discriminate — it passes against the OLD
  // process-listing implementation too, because the child-process spawn does
  // not honour a PATH mutated in-process. A test whose comment claims a
  // property it cannot detect is worse than no test.
  //
  // The property is instead secured by construction: `isPortHeld` spawns
  // nothing. The defect it replaced is documented at its definition —
  // `findPidsListeningOn` returns [] when its tool is missing or errors
  // (`myco-shared/src/port.ts`), making "couldn't look" indistinguishable from
  // "nothing there", which resolved to the destructive answer.
});

describe('readServeTcpPorts', () => {
  it('returns [] for an unconfigured node (status is `{}` with no TCP key)', async () => {
    const { cli } = fakeCli();
    expect(await readServeTcpPorts(cli)).toEqual([]);
  });

  it('reads the configured --tcp ports', async () => {
    const { cli } = fakeCli([41443, 41444]);
    expect((await readServeTcpPorts(cli)).sort()).toEqual([41443, 41444]);
  });
});

describe('retireOverlayForward', () => {
  it('removes the forward for the port', async () => {
    const { cli, ports } = fakeCli([41443]);
    await retireOverlayForward(cli, 41443);
    expect(ports.has(41443)).toBe(false);
  });

  it('is IDEMPOTENT — a port with no forward is not an error', async () => {
    // tailscale exits non-zero here, and this is the ordinary clean-shutdown
    // case; treating it as failure would make every graceful stop report one.
    const { cli } = fakeCli();
    await expect(retireOverlayForward(cli, 41443)).resolves.toBeUndefined();
  });

  it('still surfaces a genuine failure', async () => {
    const cli: TailscaleCli = {
      async run() { return { stdout: 'error: tailscaled not running', exitCode: 1 }; },
      async overlayIp() { return null; },
    };
    await expect(retireOverlayForward(cli, 41443)).rejects.toThrow(/tailscaled not running/);
  });
});

describe('reconcileOverlayForward', () => {
  it('wires the forward when none exists', async () => {
    const { cli, ports } = fakeCli();
    await reconcileOverlayForward(cli, 41443);
    expect([...ports]).toEqual([41443]);
  });

  it('REMOVES a superseded forward rather than adding beside it', async () => {
    // The port can legitimately change between runs (re-enable, or a forced
    // re-reservation). A left-behind forward is durable and points at a port
    // nothing holds — the leak this whole lifecycle exists to prevent.
    const { cli, ports } = fakeCli([41443]);
    await reconcileOverlayForward(cli, 41500);
    expect([...ports]).toEqual([41500]);
  });

  it('is a no-op when the correct forward is already present', async () => {
    const { cli, calls, ports } = fakeCli([41443]);
    await reconcileOverlayForward(cli, 41443);
    expect([...ports]).toEqual([41443]);
    // Status read only — no `off`, no re-wire.
    expect(calls.filter((c) => c.includes('off'))).toHaveLength(0);
    expect(calls.filter((c) => c.includes('--bg'))).toHaveLength(0);
  });

  it('converges from several stale forwards to exactly one', async () => {
    const { cli, ports } = fakeCli([41443, 41444, 41445]);
    await reconcileOverlayForward(cli, 41500);
    expect([...ports]).toEqual([41500]);
  });

  it('fails loudly when wiring fails — never silently leaves the listener unreachable', async () => {
    const cli: TailscaleCli = {
      async run(args) {
        if (args[1] === 'status') return { stdout: '{}', exitCode: 0 };
        return { stdout: 'error: cannot reach tailscaled', exitCode: 1 };
      },
      async overlayIp() { return null; },
    };
    await expect(reconcileOverlayForward(cli, 41443)).rejects.toThrow(/UNREACHABLE|unreachable|cannot reach/);
  });
});
// ---------------------------------------------------------------------------
// The real DaemonServer bind → wire → stop → retire ordering.
//
// Modelling this in the test would prove nothing: it must exercise the actual
// generation guard in `daemon/server.ts`, so that deleting the guard fails it.
// ---------------------------------------------------------------------------

describe('DaemonServer overlay-forward lifecycle', () => {
  let tmp: string;
  let server: DaemonServer | null = null;

  const logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  } as unknown as ConstructorParameters<typeof DaemonServer>[0]['logger'];

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-fwd-race-')); });
  afterEach(async () => {
    if (server) { await server.stop().catch(() => {}); server = null; }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function raceCli(): { cli: TailscaleCli; ports: Set<number> } {
    const ports = new Set<number>();
    const cli: TailscaleCli = {
      async run(args) {
        if (args[0] === 'serve' && args[1] === 'status') {
          const body = ports.size === 0 ? '{}' : JSON.stringify({
            TCP: Object.fromEntries([...ports].map((p) => [String(p), { TCPForward: `127.0.0.1:${p}` }])),
          });
          return { stdout: body, exitCode: 0 };
        }
        const tcpFlag = args.find((a) => a.startsWith('--tcp='));
        const port = tcpFlag ? Number(tcpFlag.slice('--tcp='.length)) : NaN;
        if (args.includes('off')) {
          if (!ports.has(port)) {
            return { stdout: 'error: failed to remove TCP serve: serve config does not exist', exitCode: 1 };
          }
          ports.delete(port);
          return { stdout: '', exitCode: 0 };
        }
        ports.add(port);
        return { stdout: '', exitCode: 0 };
      },
      async overlayIp() { return null; },
    };
    return { cli, ports };
  }

  /**
   * The socket path is INJECTED and pre-created. Without that the wire spins in
   * its 10s socket-wait against the real `~/.myco-ts/host.sock`, and a
   * mutation of the generation guard fails these tests by TIMEOUT rather than
   * by detecting a leaked forward — i.e. the test would pass for the wrong
   * reason on any box where that socket happens to exist.
   */
  function makeServer(cli: TailscaleCli): DaemonServer {
    const socketPath = path.join(tmp, 'host.sock');
    fs.writeFileSync(socketPath, '');
    return new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger,
      lockNamespace: testPerUserLockNamespace,
      hostServe: { overlayAddress: '100.64.0.7', overlayPort: 0, bearer: 'b'.repeat(64), servedGroveId: null },
      hostTailscaleCliFactory: () => cli,
      hostTailscaledSocketPath: socketPath,
    } as unknown as ConstructorParameters<typeof DaemonServer>[0]);
  }

  it('wires the forward after a successful bind', async () => {
    // Establishes the baseline the leak tests depend on: with the socket
    // present the wire really does run, so a later assertion of "no forward"
    // means the guard suppressed it — not that the wire never got that far.
    const { cli, ports } = raceCli();
    server = makeServer(cli);
    await server.start(0);
    const bound = server.overlayPort;
    await new Promise((r) => setTimeout(r, 150));
    expect(bound).toBeGreaterThan(0);
    expect([...ports]).toEqual([bound]);
  });

  it('retires the forward it wired, on a graceful stop', async () => {
    const { cli, ports } = raceCli();
    server = makeServer(cli);
    await server.start(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(ports.size).toBe(1);

    await server.stop();
    server = null;
    expect([...ports]).toEqual([]);
  });

  it('a stop during an in-flight wire neither blocks nor leaves a forward', async () => {
    // The socket NEVER appears, so the wire sits in its 10s wait. `stop()`
    // awaits the in-flight wire, so without the generation guard it would
    // block for that whole wait — and any wire that escaped would create a
    // durable forward aimed at a port this process no longer holds.
    //
    // Asserted on ELAPSED TIME, deliberately: a harness timeout would fail for
    // the right reason by accident, and would pass on any machine where the
    // real socket happened to exist.
    const { cli, ports } = raceCli();
    const socketPath = path.join(tmp, 'absent.sock'); // never created
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger,
      lockNamespace: testPerUserLockNamespace,
      hostServe: { overlayAddress: '100.64.0.7', overlayPort: 0, bearer: 'b'.repeat(64), servedGroveId: null },
      hostTailscaleCliFactory: () => cli,
      hostTailscaledSocketPath: socketPath,
      // Shorter than the harness timeout so a guard regression fails on the
      // elapsed-time ASSERTION below, not on the harness killing the test.
      hostTailscaledSocketTimeoutMs: 3000,
    } as unknown as ConstructorParameters<typeof DaemonServer>[0]);

    await server.start(0);
    const startedAt = Date.now();
    await server.stop();
    const elapsed = Date.now() - startedAt;
    server = null;

    expect(elapsed).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 250));
    expect([...ports]).toEqual([]);
  });

  it('does NOT retire a forward whose port is HELD — a sibling daemon must survive', async () => {
    // Host state lives in `~/.myco-team`, independent of MYCO_HOME, so several
    // daemons share one tailscaled. A non-serving daemon that retired every
    // forward it could see would tear down a SERVING sibling's live one — on a
    // box running dogfood beside prod, on every single boot.
    const { cli, ports } = raceCli();
    const held = net.createServer();
    await new Promise<void>((r) => held.listen(0, '127.0.0.1', () => r()));
    const heldPort = (held.address() as { port: number }).port;
    ports.add(heldPort);

    const socketPath = path.join(tmp, 'host.sock');
    fs.writeFileSync(socketPath, '');
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger,
      lockNamespace: testPerUserLockNamespace,
      hostServe: null, // this daemon is NOT serving
      hostTailscaleCliFactory: () => cli,
      hostTailscaledSocketPath: socketPath,
    } as unknown as ConstructorParameters<typeof DaemonServer>[0]);

    await server.start(0);
    await new Promise((r) => setTimeout(r, 200));

    expect([...ports]).toEqual([heldPort]); // the sibling's forward survives
    await new Promise<void>((r) => held.close(() => r()));
  });

  it('retires forwards when host serving is OFF (not-serving is a convergence target)', async () => {
    // The rule is bidirectional. Wiring-only enforced half of it: a forward
    // from a previous life stayed live with nobody holding the port, which is
    // what hands member bearer tokens to whatever binds it next.
    const { cli, ports } = raceCli();
    ports.add(41999);
    const socketPath = path.join(tmp, 'host.sock');
    fs.writeFileSync(socketPath, '');
    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger,
      lockNamespace: testPerUserLockNamespace,
      hostServe: null, // NOT serving
      hostTailscaleCliFactory: () => cli,
      hostTailscaledSocketPath: socketPath,
    } as unknown as ConstructorParameters<typeof DaemonServer>[0]);

    await server.start(0);
    await new Promise((r) => setTimeout(r, 150));
    expect([...ports]).toEqual([]);
  });

  it('retireOverlayExposure clears forwards without the rest of shutdown', async () => {
    // Shutdown runs this FIRST because everything after it can block past the
    // supervisor's kill timeout, and a forward that outlives the process keeps
    // routing member traffic to a port nothing holds.
    const { cli, ports } = raceCli();
    server = makeServer(cli);
    await server.start(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(ports.size).toBe(1);

    await server.retireOverlayExposure();
    expect([...ports]).toEqual([]);

    await server.stop();  // backstop must be idempotent
    server = null;
    expect([...ports]).toEqual([]);
  });
});
