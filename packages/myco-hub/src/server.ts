import http from 'node:http';
import os from 'node:os';
import { loadConfig, appendLog, type HubConfig } from './paths.js';
import { reconcileRunningDaemons } from './discovery.js';
import { ensureProjectRunning, restartProject, stopProject, withRuntime } from './daemon.js';
import { proxyProjectRequest } from './proxy.js';
import { getKnownProject, listKnownProjects, removeKnownProject, upsertProjectRegistration } from './registry.js';
import { renderHubFaviconSvg, renderHubHtml, renderProjectFrameHtml } from './ui.js';

const PROJECT_ACTIONS = {
  start: ensureProjectRunning,
  stop: stopProject,
  restart: restartProject,
} as const;
type ProjectAction = keyof typeof PROJECT_ACTIONS;

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
  const config = loadConfig();

  const rejection = validateHubRequest(req, url.pathname, config);
  if (rejection) {
    writeJson(res, rejection.status, { error: rejection.error });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(renderHubHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end(renderHubFaviconSvg());
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
    const runtime = await PROJECT_ACTIONS[action.action](project);
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

function matchProjectAction(pathname: string): { id: string; action: ProjectAction } | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/(start|stop|restart)$/);
  if (!match?.[1] || !match[2]) return null;
  return { id: decodeURIComponent(match[1]), action: match[2] as ProjectAction };
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

function validateHubRequest(
  req: http.IncomingMessage,
  pathname: string,
  config: HubConfig,
): { status: number; error: string } | null {
  const method = (req.method ?? '').toUpperCase();
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (!mutating) return null;

  const allowed = hubAuthorities(config);
  const host = req.headers.host;
  if (host && !allowed.hosts.has(host)) return { status: 403, error: 'forbidden_host' };

  const origin = req.headers.origin;
  if (origin && !allowed.origins.has(origin)) return { status: 403, error: 'forbidden_origin' };

  if (pathname === '/api/daemon/register' && !origin) return null;

  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) return { status: 415, error: 'unsupported_media_type' };

  return null;
}

function hubAuthorities(config: HubConfig): { hosts: Set<string>; origins: Set<string> } {
  const port = String(config.port);
  const authorities = [`127.0.0.1:${port}`, `localhost:${port}`, `${config.host}:${port}`];
  return {
    hosts: new Set(authorities),
    origins: new Set(authorities.map((authority) => `http://${authority}`)),
  };
}
