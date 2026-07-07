/**
 * Team Host — the member-side config carve handler (`daemon/attached-config.ts`).
 *
 * Each test drives the REAL handler through a member HTTP server whose listener
 * calls `handleAttachedConfigRequest`, host-sourcing the grove tier from a real
 * fixture "host" server on localhost via the real `defaultDial`. This exercises
 * the actual read carve (machine/project/personal local, grove from host), the
 * host-unreachable degrade, and the scoped-write grove-leaf refusal end to end.
 *
 * Hermetic: `MYCO_HOME` (machine tier) is a fresh tmpdir; the vault (project +
 * personal tiers) is a fresh tmpdir addressed through the `x-myco-project-root`
 * header exactly as a real member client sends it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import YAML from 'yaml';

import {
  handleAttachedConfigRequest,
  __resetAttachedConfigWarnForTests,
  type AttachedConfigDeps,
} from '@myco/daemon/attached-config';
import { defaultDial } from '@myco/daemon/host-proxy';
import type { RemoteTarget } from '@myco/host/routing';

const HOST_BEARER = 'host-bearer-secret';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}
function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let savedMycoHome: string | undefined;
let mycoHome: string;
let projectRoot: string;
let vaultDir: string;
let fixture: http.Server;
let fixturePort: number;
let member: http.Server;
let memberPort: number;
let groveResponder: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let warns: Array<[string, unknown]>;
let errors: Array<[string, unknown]>;

function target(): RemoteTarget {
  return {
    projectId: 'proj_0123456789abcdef0123456789abcdef' as RemoteTarget['projectId'],
    groveId: 'grove_0123456789abcdef0123456789abcdef',
    host: {
      host_id: 'host_0123456789abcdef0123456789abcdef',
      label: 'Mac Studio',
      overlay_address: `127.0.0.1:${fixturePort}`,
      protocol_version: 1,
    },
    bearer: HOST_BEARER,
  };
}

function deps(): AttachedConfigDeps {
  return {
    dial: defaultDial,
    logger: {
      warn: (m, meta) => warns.push([m, meta]),
      error: (m, meta) => errors.push([m, meta]),
    },
  };
}

function writeMachineConfig(doc: Record<string, unknown>): void {
  fs.writeFileSync(path.join(mycoHome, 'config.yaml'), YAML.stringify(doc), 'utf-8');
}
function writeProjectConfig(doc: Record<string, unknown>): void {
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify({ version: 3, ...doc }), 'utf-8');
}

async function request(
  method: string,
  pathname: string,
  opts: { projectRoot?: string | null; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.projectRoot !== null) headers['x-myco-project-root'] = opts.projectRoot ?? projectRoot;
  const res = await fetch(`http://127.0.0.1:${memberPort}${pathname}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  savedMycoHome = process.env.MYCO_HOME;
  mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ac-home-'));
  process.env.MYCO_HOME = mycoHome;
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ac-proj-'));
  vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  writeProjectConfig({});
  warns = [];
  errors = [];
  __resetAttachedConfigWarnForTests();

  groveResponder = (req, res) => {
    if (req.url === '/api/grove-config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ groveId: target().groveId, config: { embedding: { provider: 'openai' } } }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  };
  fixture = http.createServer((req, res) => groveResponder(req, res));
  fixturePort = await listen(fixture);

  member = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    let body: unknown;
    if (req.method === 'PUT' || req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf-8');
      body = raw ? JSON.parse(raw) : {};
    }
    await handleAttachedConfigRequest(req, res, pathname, target(), body, deps());
  });
  memberPort = await listen(member);
});

afterEach(async () => {
  await close(member);
  await close(fixture);
  fs.rmSync(mycoHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedMycoHome;
});

describe('handleAttachedConfigRequest — reads', () => {
  test('GET /api/config serves the LOCAL project config (never the host)', async () => {
    writeProjectConfig({ cortex: { enabled: false } });
    const { status, json } = await request('GET', '/api/config');
    expect(status).toBe(200);
    expect(json.version).toBe(3);
    expect(json.cortex.enabled).toBe(false);
  });

  test('GET /api/config/merged assembles machine(local) + grove(host) + project(local)', async () => {
    writeMachineConfig({ daemon: { log_level: 'debug' } });
    writeProjectConfig({ cortex: { enabled: false } });

    const { status, json } = await request('GET', '/api/config/merged');
    expect(status).toBe(200);
    expect(json.daemon.log_level).toBe('debug');     // machine tier, local disk
    expect(json.embedding.provider).toBe('openai');  // grove tier, from the host fixture
    expect(json.cortex.enabled).toBe(false);         // project tier, local disk
  });

  test('GET /api/config/merged degrades when the host is unreachable (grove → defaults, once-warn)', async () => {
    writeMachineConfig({ daemon: { log_level: 'warn' } });
    groveResponder = (_req, res) => { res.writeHead(503); res.end(); };

    const first = await request('GET', '/api/config/merged');
    expect(first.status).toBe(200);
    expect(first.json.embedding.provider).toBe('ollama'); // grove default
    expect(first.json.daemon.log_level).toBe('warn');     // machine tier still resolves

    // Second read still degrades, but the warn is deduped to once-per-host.
    await request('GET', '/api/config/merged');
    const degradeWarns = warns.filter(([m]) => m.includes('host unreachable for grove-tier config'));
    expect(degradeWarns.length).toBe(1);
  });

  test('a request with no x-myco-project-root is refused 400', async () => {
    const { status, json } = await request('GET', '/api/config', { projectRoot: null });
    expect(status).toBe(400);
    expect(json.error).toBe('missing_project_root');
  });
});

describe('handleAttachedConfigRequest — the write split', () => {
  test('a project-tier scoped write proceeds locally via updateConfig', async () => {
    const { status, json } = await request('PUT', '/api/config/scoped', {
      body: { scope: 'project', patch: { cortex: { enabled: false } } },
    });
    expect(status).toBe(200);
    expect(json.cortex.enabled).toBe(false);
    // The write landed in the member's own myco.yaml.
    const onDisk = YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8'));
    expect(onDisk.cortex.enabled).toBe(false);
  });

  test('a personal override of a grove-homed leaf is refused config_host_authoritative (409)', async () => {
    const { status, json } = await request('PUT', '/api/config/scoped', {
      body: { scope: 'local', patch: { skills: { confidence_threshold: 0.9 } } },
    });
    expect(status).toBe(409);
    expect(json.error).toBe('config_host_authoritative');
    // No local.yaml override was written — the refusal is before the write.
    expect(fs.existsSync(path.join(vaultDir, 'local.yaml'))).toBe(false);
  });

  test('a personal write of a machine-homed leaf (notifications) proceeds locally', async () => {
    const { status } = await request('PUT', '/api/config/scoped', {
      body: { scope: 'local', patch: { notifications: { enabled: false } } },
    });
    expect(status).toBe(200);
    const onDisk = YAML.parse(fs.readFileSync(path.join(vaultDir, 'local.yaml'), 'utf-8'));
    expect(onDisk.notifications.enabled).toBe(false);
  });
});
