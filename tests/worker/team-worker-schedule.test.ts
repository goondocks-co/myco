import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MIN_COMPAT_CLIENT_VERSION, SYNC_PROTOCOL_VERSION } from '@myco/constants.js';

describe('team worker deployment config', () => {
  it('declares no cron trigger, the collective refresh it existed for having been retired', () => {
    const wranglerToml = fs.readFileSync(
      path.join(process.cwd(), 'packages', 'myco-team', 'worker', 'wrangler.toml'),
      'utf-8',
    );

    // The 5-minute cron drove collective settings-sync and heartbeat. With the
    // Collective retired the handler did nothing the request path does not
    // already do — every entry point guards `schemaInitialized` itself.
    expect(wranglerToml).not.toMatch(/\[triggers\]/);
  });

  it('declares MIN_COMPAT_CLIENT_VERSION matching the daemon constant and a SYNC_PROTOCOL_VERSION that accepts the current daemon client', () => {
    // Worker [vars] are read at request time via parseInt(env.VAR, 10).
    // Two invariants must hold:
    //   1. wrangler.toml MIN_COMPAT_CLIENT_VERSION matches the daemon constant
    //      exactly — it is the oldest client the worker will accept.
    //   2. wrangler.toml SYNC_PROTOCOL_VERSION >= daemon SYNC_PROTOCOL_VERSION
    //      — the worker's server version must be at least as high as the
    //      current client version, so the daemon is inside the window
    //      [minClient, workerServer]. A worker server version BELOW the
    //      daemon client version would cause every /connect to 409.
    // When the worker leads by one (e.g. worker=3, daemon=2), the daemon
    // client still passes: 2 >= MIN_COMPAT (1) AND 2 <= workerServer (3).
    const wranglerToml = fs.readFileSync(
      path.join(process.cwd(), 'packages', 'myco-team', 'worker', 'wrangler.toml'),
      'utf-8',
    );
    const protocolMatch = wranglerToml.match(/^SYNC_PROTOCOL_VERSION\s*=\s*"(\d+)"$/m);
    const minCompatMatch = wranglerToml.match(/^MIN_COMPAT_CLIENT_VERSION\s*=\s*"(\d+)"$/m);
    const workerServerVersion = parseInt(protocolMatch?.[1] ?? '', 10);
    const workerMinCompat = parseInt(minCompatMatch?.[1] ?? '', 10);

    // MIN_COMPAT stays in lockstep with the daemon constant.
    expect(minCompatMatch?.[1]).toBe(String(MIN_COMPAT_CLIENT_VERSION));

    // Worker server version must be >= current daemon client version so
    // the daemon is accepted by /connect. Worker-leads-by-N is fine.
    expect(Number.isFinite(workerServerVersion)).toBe(true);
    expect(workerServerVersion).toBeGreaterThanOrEqual(SYNC_PROTOCOL_VERSION);

    // Daemon client must be within the worker's compat window.
    expect(SYNC_PROTOCOL_VERSION).toBeGreaterThanOrEqual(workerMinCompat);
    expect(SYNC_PROTOCOL_VERSION).toBeLessThanOrEqual(workerServerVersion);
  });
});
