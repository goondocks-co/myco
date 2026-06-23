import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolveStaticFile, resolveEmbeddedAsset, hasEmbeddedUi, MIME_TYPES } from '@myco/daemon/static';
import { BUNDLED_UI } from '@myco/ui-assets.generated';
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

describe('resolveEmbeddedAsset', () => {
  // The committed dist/ui bundle is compiled into BUNDLED_UI. These tests run
  // against the real bundle, so they assert structure (index.html always
  // exists, a /assets/* file exists) rather than hashed filenames.
  it('reports the bundle is embedded', () => {
    expect(hasEmbeddedUi()).toBe(true);
    expect(BUNDLED_UI['index.html']).toBeDefined();
  });

  it('serves index.html for /', () => {
    const result = resolveEmbeddedAsset('/');
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('text/html');
    expect(result!.cacheControl).toBe('no-cache');
    expect(result!.body.toString('utf-8').toLowerCase()).toContain('<!doctype html');
  });

  it('serves a hashed asset with immutable cache-control', () => {
    const assetKey = Object.keys(BUNDLED_UI).find((k) => k.startsWith('assets/') && k.endsWith('.js'));
    expect(assetKey).toBeDefined();
    const result = resolveEmbeddedAsset(`/${assetKey}`);
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('application/javascript');
    expect(result!.cacheControl).toContain('max-age=31536000');
    expect(result!.cacheControl).toContain('immutable');
    expect(result!.body.length).toBeGreaterThan(0);
  });

  it('falls back to index.html for SPA routes', () => {
    const result = resolveEmbeddedAsset('/configuration');
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('text/html');
    expect(result!.cacheControl).toBe('no-cache');
    expect(result!.body.toString('utf-8').toLowerCase()).toContain('<!doctype html');
  });

  it('blocks path traversal', () => {
    expect(resolveEmbeddedAsset('/../../../etc/passwd')).toBeUndefined();
  });
});
