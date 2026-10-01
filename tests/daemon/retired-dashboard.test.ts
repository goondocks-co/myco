/**
 * A 1.4 daemon answers every dashboard page with the retired-dashboard notice: an HTML page that loads no script,
 * carries no credential, and says how to reach a Deployment's dashboard instead. No dashboard build on disk changes
 * that, because the daemon reads none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority.js';
import { REQUEST_CONTEXT_AUTH_ENV } from '@myco/grove/request-context.js';
import { JOIN_A_DEPLOYMENT } from '@myco/member/join-guidance.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const DAEMON_SOURCE = path.join(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'daemon');

describe('the retired 1.4 dashboard', () => {
  const previousAuth = process.env[REQUEST_CONTEXT_AUTH_ENV];
  let listener: http.Server;
  let origin: string;
  let token: string;

  beforeAll(async () => {
    const vaultDir = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-retired-dashboard-')));
    const quiet = () => {};
    const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet } as unknown as DaemonLogger;
    const daemonStateAuthority = { read: () => null, write: quiet } as unknown as DaemonStateAuthority;
    const daemon = new DaemonServer({ vaultDir, logger, daemonStateAuthority });
    token = process.env[REQUEST_CONTEXT_AUTH_ENV]!;
    const handle = (daemon as unknown as { handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> }).handleRequest.bind(daemon);
    listener = http.createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    if (previousAuth === undefined) delete process.env[REQUEST_CONTEXT_AUTH_ENV];
    else process.env[REQUEST_CONTEXT_AUTH_ENV] = previousAuth;
  });

  it('answers every page with the one notice, carrying no script and no credential', async () => {
    expect(token.length).toBeGreaterThan(0);
    for (const pathname of ['/', '/g/default/p/myco/sessions', '/assets/index-abc123.js', '/index.html']) {
      const res = await fetch(`${origin}${pathname}`);
      const body = await res.text();
      expect({ pathname, status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control') })
        .toEqual({ pathname, status: 200, type: 'text/html; charset=utf-8', cache: 'no-cache' });
      expect(body).toContain('The 1.4 dashboard is retired');
      expect(body).toContain('myco login &lt;link&gt;');
      expect(body).not.toContain('<script');
      expect(body).not.toContain(token);
      expect(body).not.toContain('__MYCO_AUTH__');
    }
    expect(JOIN_A_DEPLOYMENT).toContain('myco server create');
  });

  it('reads no dashboard build from disk, so a stale one cannot win over the notice', () => {
    const named = fs.readdirSync(DAEMON_SOURCE).filter((file) => file.endsWith('.ts')).filter((file) => {
      const text = fs.readFileSync(path.join(DAEMON_SOURCE, file), 'utf-8');
      return /['"]dist['"],\s*['"]ui['"]|dist\/ui|uiDir|resolveStaticFile|injectDashboardBootstrap/.test(text);
    });
    expect(named).toEqual([]);
  });
});
