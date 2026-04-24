import type http from 'node:http';
import type { ProjectRecord } from './discovery.js';
import { ensureProjectRunning } from './daemon.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'host',
  'origin',
]);

export async function proxyProjectRequest(
  project: ProjectRecord,
  prefix: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const runtime = await ensureProjectRunning(project);
  if (runtime.status !== 'running' || !runtime.port) {
    writeJson(res, 503, { error: 'project_daemon_unavailable', status: runtime.status });
    return;
  }

  const incoming = new URL(req.url ?? '/', 'http://hub.local');
  let upstreamPath = incoming.pathname.slice(prefix.length);
  if (!upstreamPath.startsWith('/')) upstreamPath = `/${upstreamPath}`;
  if (upstreamPath === '/') {
    // preserve root
  }
  const target = `http://127.0.0.1:${runtime.port}${upstreamPath}${incoming.search}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  headers.set('Host', `127.0.0.1:${runtime.port}`);
  headers.set('X-Forwarded-Host', req.headers.host ?? '');
  headers.set('X-Forwarded-Proto', 'http');
  headers.set('X-Forwarded-Prefix', prefix);
  if (req.headers.origin) headers.set('Origin', `http://127.0.0.1:${runtime.port}`);

  const bodyBuffer = req.method === 'GET' || req.method === 'HEAD'
    ? undefined
    : await readBuffer(req);
  const body = bodyBuffer ? new Uint8Array(bodyBuffer) : undefined;

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    });

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of upstream.headers.entries()) {
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      responseHeaders[key] = rewriteLocation(value, key, runtime.port, prefix);
    }
    res.writeHead(upstream.status, responseHeaders);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    writeJson(res, 502, {
      error: 'project_proxy_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function rewriteLocation(value: string, key: string, port: number, prefix: string): string {
  if (key.toLowerCase() !== 'location') return value;
  try {
    const url = new URL(value);
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === String(port)) {
      return `${prefix}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    if (value.startsWith('/')) return `${prefix}${value}`;
  }
  return value;
}

function readBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
