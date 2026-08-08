/**
 * `myco host members` / `myco host revoke` — the recovery path for a member
 * that vanished without leaving.
 *
 * A host admits one enrollment per machine id, so a member whose Myco state was
 * wiped (reinstall, disk swap, a torn-down test box) is refused on re-join with
 * `machine_already_enrolled` and cannot clear itself: `leave` resigns from the
 * MEMBER side, and its state is exactly what is gone. Before these commands the
 * operator's only option was hand-editing the host's `members.json` — which is
 * what the rig actually had to do.
 *
 * Driven end to end: the real command against a real daemon HTTP surface. A
 * stubbed client would not have caught the envelope defect that shipped
 * `rotate-key` dead twice.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runHostCommand } from '@myco/cli/host';
import { resolveDaemonServiceState } from '@myco/daemon/service-state';

/** Thrown by the `process.exit` stub so execution halts where the real one would. */
class ExitCalled extends Error {}

async function run(args: string[]): Promise<void> {
  try {
    await runHostCommand(args);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
  }
}

describe('myco host members / revoke (driven)', () => {
  let tmp: string;
  let server: http.Server;
  let revokeBodies: unknown[];
  let membersResponse: { status: number; body: unknown };
  let revokeResponse: { status: number; body: unknown };
  let out: string[];
  let err: string[];
  let exits: number[];
  let savedLog: typeof console.log;
  let savedErr: typeof console.error;
  let savedExit: typeof process.exit;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-members-'));
    savedHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = tmp;

    revokeBodies = [];
    membersResponse = {
      status: 200,
      body: {
        members: [
          { id: 'mem-1', machine_id: 'local_ecbaa70d', label: 'ubuntu-linux-2404', issued_at: '2026-08-07T04:51:55.547Z' },
        ],
        join_keys: [],
      },
    };
    revokeResponse = { status: 200, body: { ok: true } };

    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/host-admin/members')) {
        res.writeHead(membersResponse.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(membersResponse.body));
        return;
      }
      if (req.url?.startsWith('/api/host-admin/revoke')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try { revokeBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { revokeBodies.push(null); }
          res.writeHead(revokeResponse.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(revokeResponse.body));
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: true, ready: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    const state = resolveDaemonServiceState(tmp, { env: process.env });
    fs.mkdirSync(state.stateDir, { recursive: true });
    fs.writeFileSync(state.statePath, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }));

    out = []; err = []; exits = [];
    savedLog = console.log; savedErr = console.error; savedExit = process.exit;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
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

  test('members lists the enrolled machine, with the id revoke takes', async () => {
    await run(['members']);
    const text = out.join('\n');
    expect(exits).toEqual([]);
    // The MACHINE id is what the operator recognizes; the MEMBER id is what
    // revoke needs. Printing only one of them makes the pair unusable.
    expect(text).toContain('mem-1');
    expect(text).toContain('local_ecbaa70d');
    expect(text).toContain('ubuntu-linux-2404');
    expect(text).toContain('myco host revoke');
  });

  test('an empty roster says so rather than printing a bare header', async () => {
    membersResponse = { status: 200, body: { members: [], join_keys: [] } };
    await run(['members']);
    expect(out.join('\n')).toContain('No members enrolled');
    expect(exits).toEqual([]);
  });

  test('revoke sends the member id and reports success', async () => {
    await run(['revoke', 'mem-1']);
    expect(revokeBodies).toEqual([{ member_id: 'mem-1' }]);
    expect(out.join('\n')).toContain('Revoked mem-1');
    // The operator's actual next step: that machine can join again.
    expect(out.join('\n')).toContain('rotate-key');
    expect(exits).toEqual([]);
  });

  test("a daemon REFUSAL surfaces the daemon's own reason, not a generic failure", async () => {
    revokeResponse = { status: 404, body: { error: 'unknown_member', message: 'No member mem-9 on this host.' } };
    await run(['revoke', 'mem-9']);
    expect(err.join('\n')).toContain('No member mem-9 on this host.');
    expect(exits).toEqual([1]);
  });

  test('revoke with NO member id refuses and sends nothing', async () => {
    await run(['revoke']);
    expect(revokeBodies).toEqual([]);
    expect(err.join('\n')).toContain('myco host members');
    expect(exits).toEqual([1]);
  });

  test('a FLAG in the id position is refused, never sent as an id', async () => {
    // `myco host revoke --all` would otherwise POST `member_id: "--all"` and
    // report a confusing 404 for a member nobody named.
    await run(['revoke', '--all']);
    expect(revokeBodies).toEqual([]);
    expect(exits).toEqual([1]);
  });

  test('both commands are advertised in the help', async () => {
    const { HOST_HELP } = await import('@myco/cli/host');
    expect(HOST_HELP).toContain('members');
    expect(HOST_HELP).toContain('revoke');
  });
});
