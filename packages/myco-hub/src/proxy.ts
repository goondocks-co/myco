import type http from 'node:http';
import type { ProjectRecord } from './discovery.js';
import { ensureProjectRunning, getRuntime } from './daemon.js';

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
  options: { startIfNeeded?: boolean } = {},
): Promise<void> {
  const runtime = options.startIfNeeded === false
    ? await getRuntime(project)
    : await ensureProjectRunning(project);
  if (runtime.status !== 'running' || !runtime.port) {
    writeJson(res, 503, { error: 'project_daemon_unavailable', status: runtime.status });
    return;
  }

  const incoming = new URL(req.url ?? '/', 'http://hub.local');
  let upstreamPath = incoming.pathname.slice(prefix.length);
  if (!upstreamPath.startsWith('/')) upstreamPath = `/${upstreamPath}`;
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
    if (req.method === 'HEAD') {
      res.writeHead(upstream.status, responseHeaders);
      res.end();
      return;
    }
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    if (isHtmlResponse(responseHeaders['content-type'])) {
      delete responseHeaders['content-length'];
      responseHeaders['cache-control'] = 'no-cache';
      res.writeHead(upstream.status, responseHeaders);
      res.end(rewriteHtml(upstreamBody.toString('utf-8'), prefix));
      return;
    }
    if (isCssResponse(responseHeaders['content-type'])) {
      delete responseHeaders['content-length'];
      responseHeaders['cache-control'] = 'no-cache';
      res.writeHead(upstream.status, responseHeaders);
      res.end(rewriteCss(upstreamBody.toString('utf-8'), prefix));
      return;
    }
    res.writeHead(upstream.status, responseHeaders);
    res.end(upstreamBody);
  } catch (error) {
    writeJson(res, 502, {
      error: 'project_proxy_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function isHtmlResponse(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().includes('text/html');
}

function isCssResponse(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().includes('text/css');
}

function rewriteHtml(html: string, prefix: string): string {
  const rewritten = html.replace(
    /\b(src|href|action)=("|')\/(?!\/)([^"']*)\2/g,
    (_match, attr: string, quote: string, value: string) => `${attr}=${quote}${cacheBust(`${prefix}/${value}`)}${quote}`,
  );
  const shim = `<script>${hubCompatibilityShim(prefix)}</script>`;
  if (rewritten.includes('</head>')) return rewritten.replace('</head>', `${shim}</head>`);
  return `${shim}${rewritten}`;
}

function rewriteCss(css: string, prefix: string): string {
  return css.replace(
    /url\((["']?)\/(?!\/)([^)"']+)\1\)/g,
    (_match, quote: string, value: string) => `url(${quote}${cacheBust(`${prefix}/${value}`)}${quote})`,
  );
}

function cacheBust(value: string): string {
  const separator = value.includes('?') ? '&' : '?';
  return `${value}${separator}myco_hub_proxy=1`;
}

function hubCompatibilityShim(prefix: string): string {
  return `
(function () {
  var prefix = ${JSON.stringify(prefix)};
  window.__MYCO_HUB_PREFIX__ = prefix;
  function shouldRewrite(value) {
    return typeof value === 'string'
      && value.charAt(0) === '/'
      && value.indexOf(prefix + '/') !== 0
      && value.indexOf('/view/') !== 0;
  }
  function rewrite(value) {
    return shouldRewrite(value) ? prefix + value : value;
  }
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') return originalFetch.call(this, rewrite(input), init);
    if (input instanceof URL && input.origin === window.location.origin && shouldRewrite(input.pathname)) {
      return originalFetch.call(this, rewrite(input.pathname + input.search + input.hash), init);
    }
    if (input instanceof Request) {
      var url = new URL(input.url);
      if (url.origin === window.location.origin && shouldRewrite(url.pathname)) {
        return originalFetch.call(this, new Request(rewrite(url.pathname + url.search + url.hash), input), init);
      }
    }
    return originalFetch.call(this, input, init);
  };
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string') arguments[1] = rewrite(url);
    return originalOpen.apply(this, arguments);
  };
  if (window.EventSource) {
    var OriginalEventSource = window.EventSource;
    window.EventSource = function (url, config) {
      return new OriginalEventSource(typeof url === 'string' ? rewrite(url) : url, config);
    };
  }
})();`.trim();
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
