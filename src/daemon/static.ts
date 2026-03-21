import fs from 'node:fs';
import path from 'node:path';

const HASHED_ASSET_PREFIX = '/assets/';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface StaticFileResult {
  filePath: string;
  contentType: string;
  cacheControl: string;
}

/** Resolve a request to a file in the UI directory. Returns undefined if blocked (path traversal). */
export function resolveStaticFile(uiDir: string, pathname: string): StaticFileResult | undefined {
  // Strip leading slash to get relative path
  const relative = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  // Resolve "/" to index.html
  const resolved = path.resolve(uiDir, relative || 'index.html');
  if (!resolved.startsWith(path.resolve(uiDir))) {
    return undefined;
  }

  // Serve the file if it exists
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const ext = path.extname(resolved);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const cacheControl = pathname.startsWith(HASHED_ASSET_PREFIX) ? IMMUTABLE_CACHE : NO_CACHE;
    return { filePath: resolved, contentType, cacheControl };
  }

  // SPA fallback: serve index.html for any non-file path
  const indexPath = path.join(uiDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    return { filePath: indexPath, contentType: 'text/html', cacheControl: NO_CACHE };
  }

  return undefined;
}
