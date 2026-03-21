import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveStaticFile, MIME_TYPES } from '@myco/daemon/static';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('resolveStaticFile', () => {
  let uiDir: string;

  beforeEach(() => {
    uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ui-'));
    fs.mkdirSync(path.join(uiDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(uiDir, 'assets', 'index-abc123.js'), 'console.log("ok")');
  });

  afterEach(() => {
    fs.rmSync(uiDir, { recursive: true, force: true });
  });

  it('resolves existing files', () => {
    const result = resolveStaticFile(uiDir, '/assets/index-abc123.js');
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('application/javascript');
    expect(result!.cacheControl).toContain('max-age=31536000');
  });

  it('falls back to index.html for SPA routes', () => {
    const result = resolveStaticFile(uiDir, '/configuration');
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('text/html');
    expect(result!.cacheControl).toBe('no-cache');
  });

  it('blocks path traversal', () => {
    const result = resolveStaticFile(uiDir, '/../../../etc/passwd');
    expect(result).toBeUndefined();
  });

  it('serves index.html for /', () => {
    const result = resolveStaticFile(uiDir, '/');
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('text/html');
  });
});

describe('MIME_TYPES', () => {
  it('maps common extensions', () => {
    expect(MIME_TYPES['.js']).toBe('application/javascript');
    expect(MIME_TYPES['.css']).toBe('text/css');
    expect(MIME_TYPES['.svg']).toBe('image/svg+xml');
  });
});
