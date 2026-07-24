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
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
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
import { defaultDial, __resetVersionMismatchLogForTests } from '@myco/daemon/host-proxy';
import { type HostRecord } from '@myco/host/registry';
import { HOST_PROTOCOL_HEADER } from '@myco/constants';
import type { RemoteTarget } from '@myco/host/routing';

const HOST_BEARER = 'host-bearer-secret';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}
function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let savedMycoHome: string | undefined;
let savedTeamHome: string | undefined;
let teamHome: string;
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
  // Fresh, empty attach registry per test — resolveAttach reads MYCO_TEAM_HOME.
  savedTeamHome = process.env.MYCO_TEAM_HOME;
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ac-team-'));
  process.env.MYCO_TEAM_HOME = teamHome;
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ac-proj-'));
  vaultDir = path.join(projectRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  writeProjectConfig({});
  warns = [];
  errors = [];
  __resetAttachedConfigWarnForTests();
  __resetVersionMismatchLogForTests();

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
  fs.rmSync(teamHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
  if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedMycoHome;
  if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
  else process.env.MYCO_TEAM_HOME = savedTeamHome;
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

  test('no x-myco-project-root AND no attach-record root → 400', async () => {
    // Fresh empty attach registry (no seeded record) → the fallback finds no
    // root either, so the request is refused.
    const { status, json } = await request('GET', '/api/config', { projectRoot: null });
    expect(status).toBe(400);
    expect(json.error).toBe('missing_project_root');
  });

  test('browser-shaped headers (grove-id + project-id, NO project-root) resolve the vault from the attach record root', async () => {
    // The browser Settings UI cannot know the filesystem path — it sends only
    // grove/project ids. The member falls back to the root recorded on the
    // attach record at attach time, so the carve works end to end.
    writeProjectConfig({ cortex: { enabled: false } });
    const t = target();
    writeHostRecordFixture({
      host_id: t.host.host_id,
      label: t.host.label,
      overlay_address: t.host.overlay_address,
      protocol_version: 1,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: t.groveId, project_id: t.projectId, root: projectRoot }],
    } satisfies HostRecord);

    const res = await fetch(`http://127.0.0.1:${memberPort}/api/config`, {
      method: 'GET',
      headers: { 'x-myco-grove-id': t.groveId, 'x-myco-project-id': t.projectId },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.version).toBe(3);
    expect(json.cortex.enabled).toBe(false);
  });

  test('GET /api/config/merged: host 409 protocol skew → loud version-mismatch log + defaults, NOT the unreachable warn', async () => {
    writeMachineConfig({ daemon: { log_level: 'warn' } });
    groveResponder = (_req, res) => {
      res.writeHead(409, { [HOST_PROTOCOL_HEADER]: '2', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'protocol_version_unsupported' }));
    };

    const { status, json } = await request('GET', '/api/config/merged');
    expect(status).toBe(200);
    expect(json.embedding.provider).toBe('ollama'); // grove tier degraded to defaults
    expect(json.daemon.log_level).toBe('warn');     // machine tier still resolves

    // The loud version-mismatch log fired; the "unreachable" warn did NOT.
    const versionErrs = errors.filter(([m]) => m.includes('host protocol mismatch'));
    expect(versionErrs.length).toBe(1);
    const unreachableWarns = warns.filter(([m]) => m.includes('host unreachable for grove-tier config'));
    expect(unreachableWarns.length).toBe(0);
  });
});

describe('handleAttachedConfigRequest — a missing project myco.yaml is tolerated (fresh attach)', () => {
  // A fresh clone-then-attach has the working tree but no `.myco/myco.yaml`
  // yet. The carve must behave like a local project with the same missing file
  // (loadMergedConfig `projectTierOptional`): resolve machine + grove tiers,
  // contribute project-tier defaults, and never 500. Absence is tolerated;
  // corruption is not.
  function removeProjectConfig(): void {
    fs.rmSync(path.join(vaultDir, 'myco.yaml'), { force: true });
  }

  test('GET /api/config/merged → 200 with grove(host) + machine(local), project tier defaulted', async () => {
    writeMachineConfig({ daemon: { log_level: 'debug' } });
    removeProjectConfig();

    const { status, json } = await request('GET', '/api/config/merged');
    expect(status).toBe(200);
    expect(json.version).toBe(3);
    expect(json.daemon.log_level).toBe('debug');    // machine tier, local disk
    expect(json.embedding.provider).toBe('openai'); // grove tier, from the host fixture
    expect(json.cortex.enabled).toBe(true);         // project tier absent → schema default
    // The carve never materialized a myco.yaml for the member.
    expect(fs.existsSync(path.join(vaultDir, 'myco.yaml'))).toBe(false);
  });

  test('GET /api/config/merged with a PRESENT-but-malformed myco.yaml still 500s attached_config_failed', async () => {
    // Corruption is NOT absence — a malformed present file must still surface
    // the failure envelope, not be papered over by the absence tolerance.
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'foo: [1, 2\n', 'utf-8');
    const { status, json } = await request('GET', '/api/config/merged');
    expect(status).toBe(500);
    expect(json.error).toBe('attached_config_failed');
  });

  test('GET /api/config → 200 with the project-tier stand-in (never 500)', async () => {
    removeProjectConfig();
    const { status, json } = await request('GET', '/api/config');
    expect(status).toBe(200);
    expect(json.version).toBe(3);
    expect(json.cortex.enabled).toBe(true); // schema default — no project file
    // Reading the config never materialized one.
    expect(fs.existsSync(path.join(vaultDir, 'myco.yaml'))).toBe(false);
  });

  test('GET /api/config with a PRESENT-but-malformed myco.yaml still 500s attached_config_failed', async () => {
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'foo: [1, 2\n', 'utf-8');
    const { status, json } = await request('GET', '/api/config');
    expect(status).toBe(500);
    expect(json.error).toBe('attached_config_failed');
  });

  test('scope=project write CREATES myco.yaml from the skeleton, applies the patch, and round-trips', async () => {
    removeProjectConfig();
    const write = await request('PUT', '/api/config/scoped', {
      body: { scope: 'project', patch: { cortex: { enabled: false } } },
    });
    expect(write.status).toBe(200);
    expect(write.json.cortex.enabled).toBe(false);

    // The write created the member's myco.yaml from the stand-in skeleton.
    const onDisk = YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8'));
    expect(onDisk.version).toBe(3);
    expect(onDisk.cortex.enabled).toBe(false);

    // A subsequent merged read round-trips the written project-tier value while
    // the grove tier is still host-sourced.
    const merged = await request('GET', '/api/config/merged');
    expect(merged.status).toBe(200);
    expect(merged.json.cortex.enabled).toBe(false);
    expect(merged.json.embedding.provider).toBe('openai');
  });

  test('scope=local write is tolerant of the absent project file and never creates myco.yaml', async () => {
    removeProjectConfig();
    const { status } = await request('PUT', '/api/config/scoped', {
      body: { scope: 'local', patch: { notifications: { enabled: false } } },
    });
    expect(status).toBe(200);

    // The personal overlay landed; the project file was NOT materialized.
    const onDisk = YAML.parse(fs.readFileSync(path.join(vaultDir, 'local.yaml'), 'utf-8'));
    expect(onDisk.notifications.enabled).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, 'myco.yaml'))).toBe(false);
  });

  test('fresh attach with the host ALSO down: merged still 200, grove failure surfaced (never a 500)', async () => {
    // The real-world fresh-clone-then-attach failure mode: no myco.yaml AND the
    // host unreachable. Absence tolerance (project defaults) and the T1 grove
    // degrade (grove defaults + once-warn) COMPOSE — the envelope fires for
    // neither, but the grove-tier failure is still surfaced, not swallowed.
    writeMachineConfig({ daemon: { log_level: 'warn' } });
    removeProjectConfig();
    groveResponder = (_req, res) => { res.writeHead(503); res.end(); };

    const { status, json } = await request('GET', '/api/config/merged');
    expect(status).toBe(200);
    expect(json.version).toBe(3);
    expect(json.daemon.log_level).toBe('warn');     // machine tier, local disk
    expect(json.embedding.provider).toBe('ollama'); // grove tier degraded to default
    const degradeWarns = warns.filter(([m]) => m.includes('host unreachable for grove-tier config'));
    expect(degradeWarns.length).toBe(1);
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
