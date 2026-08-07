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
 * `myco host rotate-key` is RUN, against a real daemon HTTP surface.
 *
 * Every other gate on this command is static — one asserts the string
 * "rotate-key" appears in help, another checks advertised flags against the
 * parser. Both passed while the command was a stub that exited 2, and both
 * passed again when it was rewired to read the response body off the transport
 * envelope (`{ok, data}`) instead of out of `data`: every field of the body is
 * optional, so the envelope satisfies the asserted shape and the cast is legal.
 * The command reported failure on a successful mint while the key had already
 * been created and persisted — an operator retrying three times left three live
 * invitations they never saw.
 *
 * Nothing short of running the command catches that, so this runs it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runHostCommand } from '@myco/cli/host';
import { resolveDaemonServiceState } from '@myco/daemon/service-state';

const JOIN_COMMAND = 'myco join host_abc --host-url https://box.tail1234.ts.net:8443 --key THE-RAW-KEY';

/** Thrown by the `process.exit` stub so control stops where it really would. */
class ExitCalled extends Error {}

/** Run the command the way the CLI does, absorbing the simulated exit. */
async function run(args: string[]): Promise<void> {
  try {
    await runHostCommand(args);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
  }
}

describe('myco host rotate-key (driven)', () => {
  let tmp: string;
  let server: http.Server;
  let mintCalls: number;
  let mintResponse: { status: number; body: unknown };
  let out: string[];
  let err: string[];
  let exits: number[];
  let savedLog: typeof console.log;
  let savedErr: typeof console.error;
  let savedExit: typeof process.exit;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rotate-key-'));
    savedHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = tmp;

    mintCalls = 0;
    mintResponse = { status: 200, body: { key: 'THE-RAW-KEY', expires: '2026-01-01T00:00:00Z', join_command: JOIN_COMMAND } };

    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/host-admin/mint-join-key')) {
        mintCalls += 1;
        res.writeHead(mintResponse.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mintResponse.body));
        return;
      }
      // Health probe — the client refuses to talk to a daemon it cannot reach.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: true, ready: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    // A real daemon state file where the client looks for one.
    const state = resolveDaemonServiceState(tmp, { env: process.env });
    fs.mkdirSync(state.stateDir, { recursive: true });
    fs.writeFileSync(state.statePath, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }));

    out = []; err = []; exits = [];
    savedLog = console.log; savedErr = console.error; savedExit = process.exit;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
    // Records the code AND halts, because the real `process.exit` does. A stub
    // that merely records lets execution fall through paths production never
    // reaches, which reports a second exit that cannot happen.
    (process as { exit: unknown }).exit = ((code?: number) => {
      exits.push(code ?? 0);
      throw new ExitCalled();
    }) as typeof process.exit;
  });

  afterEach(async () => {
    console.log = savedLog; console.error = savedErr; process.exit = savedExit;
    if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a SUCCESSFUL mint prints the join command and does NOT report failure', async () => {
    await run(['rotate-key']);

    expect(mintCalls).toBe(1);
    expect(out.join('\n')).toContain(JOIN_COMMAND);
    expect(err).toEqual([]);
    expect(exits).toEqual([]);
  });

  test('the raw key reaches the operator — a minted key that is never shown is a lost invitation', async () => {
    await run(['rotate-key']);
    expect(out.join('\n')).toContain('THE-RAW-KEY');
  });

  test("a daemon REFUSAL surfaces the daemon's own reason, not a generic failure", async () => {
    // `not_a_host` and `host_not_published` name different next steps.
    mintResponse = {
      status: 409,
      body: { error: 'host_not_published', message: 'This host has no public address yet.' },
    };

    await run(['rotate-key']);

    expect(err.join('\n')).toContain('no public address yet');
    expect(exits).toEqual([1]);
    expect(out.join('\n')).not.toContain('Join command');
  });

  test('--expiration reaches the daemon', async () => {
    let seen: unknown;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url?.startsWith('/api/host-admin/mint-join-key')) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          seen = JSON.parse(raw || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ key: 'k', join_command: JOIN_COMMAND }));
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: true, ready: true }));
    });

    await run(['rotate-key', '--expiration', '30m']);
    expect((seen as { expiration?: string })?.expiration).toBe('30m');
  });
});
