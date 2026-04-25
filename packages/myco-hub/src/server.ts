import http from 'node:http';
import os from 'node:os';
import { loadConfig, appendLog } from './paths.js';
import { reconcileRunningDaemons } from './discovery.js';
import { ensureProjectRunning, restartProject, stopProject, withRuntime } from './daemon.js';
import { proxyProjectRequest } from './proxy.js';
import { getKnownProject, listKnownProjects, removeKnownProject, upsertProjectRegistration } from './registry.js';
import { renderHubHtml, renderProjectFrameHtml } from './ui.js';

export async function serve(): Promise<void> {
  const config = loadConfig();
  const server = createHubServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      appendLog('hub started', { host: config.host, port: config.port, pid: process.pid });
      resolve();
    });
  });
}

export function createHubServer(): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      appendLog('request failed', { error: error instanceof Error ? error.message : String(error) });
      writeJson(res, 500, { error: 'hub_request_failed' });
    });
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://hub.local');

  const rejection = validateHubRequest(req, url.pathname);
  if (rejection) {
    writeJson(res, rejection.status, { error: rejection.error });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(renderHubHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, { mycoHub: true, pid: process.pid });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/daemon/register') {
    res.writeHead(303, { Location: '/' });
    res.end();
    return;
  }

  const frame = matchProjectFrame(url.pathname);
  if (frame && req.method === 'GET') {
    const project = findProject(frame.id);
    if (!project) {
      writeJson(res, 404, { error: 'project_not_found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(renderProjectFrameHtml(project, listKnownProjects()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const config = loadConfig();
    if (config.reconcile_running_daemons) await reconcileRunningDaemons();
    const projects = await Promise.all(listKnownProjects().map(withRuntime));
    writeJson(res, 200, {
      hub: {
        host: config.host,
        hostname: os.hostname(),
        port: config.port,
      },
      projects,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/daemon/register') {
    const body = await readJson(req);
    const project = upsertProjectRegistration(body as Parameters<typeof upsertProjectRegistration>[0], 'registration');
    writeJson(res, 200, { ok: true, project });
    return;
  }

  const action = matchProjectAction(url.pathname);
  if (action && req.method === 'POST') {
    const project = findProject(action.id);
    if (!project) {
      writeJson(res, 404, { error: 'project_not_found' });
      return;
    }
    const runtime = action.action === 'start'
      ? await ensureProjectRunning(project)
      : action.action === 'stop'
        ? await stopProject(project)
        : await restartProject(project);
    writeJson(res, 200, { project: { ...project, runtime } });
    return;
  }

  const forget = matchProjectForget(url.pathname);
  if (forget && req.method === 'POST') {
    writeJson(res, 200, { ok: removeKnownProject(forget.id) });
    return;
  }

  const proxy = matchProxy(url.pathname);
  if (proxy) {
    const project = findProject(proxy.id);
    if (!project) {
      writeJson(res, 404, { error: 'project_not_found' });
      return;
    }
    await proxyProjectRequest(project, proxy.prefix, req, res, {
      startIfNeeded: !isPassiveProxyPath(url.pathname, proxy.prefix),
    });
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
}

function findProject(id: string) {
  return getKnownProject(id);
}

function matchProjectAction(pathname: string): { id: string; action: 'start' | 'stop' | 'restart' } | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/(start|stop|restart)$/);
  if (!match?.[1] || !match[2]) return null;
  return { id: decodeURIComponent(match[1]), action: match[2] as 'start' | 'stop' | 'restart' };
}

function matchProjectForget(pathname: string): { id: string } | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/forget$/);
  if (!match?.[1]) return null;
  return { id: decodeURIComponent(match[1]) };
}

function matchProxy(pathname: string): { id: string; prefix: string } | null {
  const match = pathname.match(/^\/p\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return null;
  const id = decodeURIComponent(match[1]);
  return { id, prefix: `/p/${match[1]}` };
}

function matchProjectFrame(pathname: string): { id: string } | null {
  const match = pathname.match(/^\/view\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return null;
  return { id: decodeURIComponent(match[1]) };
}

function isPassiveProxyPath(pathname: string, prefix: string): boolean {
  const upstreamPath = pathname.slice(prefix.length) || '/';
  return upstreamPath === '/api/stats';
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf-8'); });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function validateHubRequest(req: http.IncomingMessage, pathname: string): { status: number; error: string } | null {
  const method = (req.method ?? '').toUpperCase();
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (!mutating) return null;

  const host = req.headers.host;
  if (host && !isHubHost(host)) return { status: 403, error: 'forbidden_host' };

  const origin = req.headers.origin;
  if (origin && !isHubOrigin(origin)) return { status: 403, error: 'forbidden_origin' };

  if (pathname === '/api/daemon/register' && !origin) return null;

  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) return { status: 415, error: 'unsupported_media_type' };

  return null;
}

function isHubHost(host: string): boolean {
  const config = loadConfig();
  const port = String(config.port);
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `${config.host}:${port}`;
}

function isHubOrigin(origin: string): boolean {
  const config = loadConfig();
  const port = String(config.port);
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    origin === `http://${config.host}:${port}`
  );
}
