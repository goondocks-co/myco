import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MIN_COMPAT_CLIENT_VERSION, SYNC_PROTOCOL_VERSION } from '@myco/constants.js';

describe('team worker deployment config', () => {
  it('declares a cron trigger for collective refresh', () => {
    const wranglerToml = fs.readFileSync(
      path.join(process.cwd(), 'packages', 'myco-team', 'worker', 'wrangler.toml'),
      'utf-8',
    );

    expect(wranglerToml).toMatch(/\[triggers\][\s\S]*crons = \["\*\/5 \* \* \* \*"\]/);
  });

  it('declares SYNC_PROTOCOL_VERSION + MIN_COMPAT_CLIENT_VERSION matching the daemon constants', () => {
    // Worker [vars] are read at request time via parseInt(env.VAR, 10).
    // The wrangler.toml string literal MUST match the daemon-side
    // SYNC_PROTOCOL_VERSION / MIN_COMPAT_CLIENT_VERSION exactly — out
    // of lockstep, the worker's compat window is wrong on every
    // request and the gates in handleEnqueue/initD1Schema misbehave.
    const wranglerToml = fs.readFileSync(
      path.join(process.cwd(), 'packages', 'myco-team', 'worker', 'wrangler.toml'),
      'utf-8',
    );
    const protocolMatch = wranglerToml.match(/^SYNC_PROTOCOL_VERSION\s*=\s*"(\d+)"$/m);
    const minCompatMatch = wranglerToml.match(/^MIN_COMPAT_CLIENT_VERSION\s*=\s*"(\d+)"$/m);
    expect(protocolMatch?.[1]).toBe(String(SYNC_PROTOCOL_VERSION));
    expect(minCompatMatch?.[1]).toBe(String(MIN_COMPAT_CLIENT_VERSION));
  });
});
