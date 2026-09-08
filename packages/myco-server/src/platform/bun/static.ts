/**
 * The dashboard's static build, served beside the self-hosted server.
 *
 * Paths the server owns — `ownedPathPatterns()` — go to the server untouched.
 * Every other GET or HEAD answers a file from the build when one exists, and
 * the shell's `index.html` when none does, which is what a single-page
 * application needs on a hard refresh of a deep route. Any other method on a
 * path the server does not own answers 405.
 *
 * Two sources, one behaviour: a build DIRECTORY a deployment mounts, and a
 * build the deployment CARRIES as bytes. The owned-path check, the media types,
 * the cache rule, the frame refusal and the escape refusal are shared, so the
 * two sources cannot answer differently.
 *
 * The hosted target gets the same behaviour from its edge asset store; this
 * is the one place the self-hosted target supplies it.
 */
import { statSync } from 'node:fs';
import { extname, posix, resolve, sep } from 'node:path';
import { isOwnedPath, ownedPathPatterns } from '../../routes.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Hashed build output under `/assets/` never changes at a given path; everything else may on the next deploy. */
function cacheControlFor(pathname: string): string {
  return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** The shell is never framed: a page that binds an account to a member must be the top-level document the person reads. */
export const FRAME_HEADERS = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" } as const;

const notFound = (): Response => new Response(null, { status: 404 });

export type Fetch = (request: Request) => Promise<Response>;

/** Wraps the server's fetch with static serving for the paths it does not own. */
export function withStaticAssets(uiDir: string, next: Fetch): Fetch {
  const root = resolve(uiDir);
  const patterns = ownedPathPatterns();
  const index = resolve(root, 'index.html');

  const respond = (path: string, pathname: string, method: string): Response => {
    const headers = {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': cacheControlFor(pathname),
      ...FRAME_HEADERS,
    };
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(Bun.file(path), { status: 200, headers });
  };

  return async (request) => {
    const url = new URL(request.url);
    if (isOwnedPath(url.pathname, patterns)) return next(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    if (decoded.includes('\0')) return notFound();

    // Resolved against the build root; a path that escapes it is refused rather than read.
    const candidate = resolve(root, `.${decoded}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return notFound();

    if (candidate !== root && isFile(candidate)) return respond(candidate, url.pathname, request.method);
    if (!isFile(index)) return notFound();
    return respond(index, '/index.html', request.method);
  };
}

/**
 * A build the deployment carries: keys are paths relative to the build root,
 * forward slashes, no leading slash — the shape `index.html` is stored under.
 */
export type StaticAssets = Readonly<Record<string, Uint8Array>>;

const INDEX_KEY = 'index.html';

/** Wraps the server's fetch with static serving from a build held in memory. */
export function withStaticMap(assets: StaticAssets, next: Fetch): Fetch {
  const patterns = ownedPathPatterns();

  const respond = (key: string, pathname: string, method: string): Response => {
    const body = assets[key]!;
    const headers = {
      'content-type': TYPES[posix.extname(key)] ?? 'application/octet-stream',
      'cache-control': cacheControlFor(pathname),
      ...FRAME_HEADERS,
    };
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    // A fresh view per response: one buffer handed to two responses is one
    // stream two callers would consume.
    return new Response(body.slice(), { status: 200, headers });
  };

  return async (request) => {
    const url = new URL(request.url);
    if (isOwnedPath(url.pathname, patterns)) return next(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    if (decoded.includes('\0')) return notFound();

    // Resolved against a virtual root the same way the directory path resolves
    // against a real one, so a traversal is refused rather than looked up.
    // POSIX semantics on every platform: the keys are build-relative URL paths,
    // and a Windows resolve would answer them with a drive letter and
    // backslashes that no key carries.
    const key = posix.resolve('/', `.${decoded}`).slice(1);
    if (key !== '' && Object.hasOwn(assets, key)) return respond(key, url.pathname, request.method);
    if (!Object.hasOwn(assets, INDEX_KEY)) return notFound();
    return respond(INDEX_KEY, '/index.html', request.method);
  };
}
