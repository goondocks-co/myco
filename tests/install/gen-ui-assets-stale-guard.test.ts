import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The script is guarded by an is-main check (argv[1] vs import.meta.url), so
// importing it MUST NOT run codegen against the real dist/ui. If that guard
// regresses, this import would rewrite src/ui-assets.generated.ts mid-test.
import { findStaleAssets } from '../../packages/myco/scripts/gen-ui-assets';

interface Fixture {
  distDir: string;
  publicDir: string;
}

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    fs.rmSync(cleanups.pop()!, { recursive: true, force: true });
  }
});

function makeFixture(files: Record<string, string>, publicFiles: string[] = []): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-ui-assets-guard-'));
  cleanups.push(root);
  const distDir = path.join(root, 'dist');
  const publicDir = path.join(root, 'public');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(distDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  for (const rel of publicFiles) {
    const abs = path.join(publicDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'public asset');
  }
  fs.mkdirSync(publicDir, { recursive: true });
  return { distDir, publicDir };
}

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, root));
    else out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

describe('findStaleAssets', () => {
  it('passes a clean Vite output: entry chunk, css, transitively referenced font', () => {
    const { distDir, publicDir } = makeFixture({
      'index.html': '<script src="/assets/index-Abc123.js"></script><link href="/assets/index-Css456.css">',
      'assets/index-Abc123.js': 'console.log("app")',
      // Font is referenced only from CSS — requires the BFS fixpoint, not a
      // single scan of index.html.
      'assets/index-Css456.css': '@font-face{src:url(/assets/Geist-Xyz789.woff2)}',
      'assets/Geist-Xyz789.woff2': 'binary-ish',
    });
    expect(findStaleAssets(distDir, walk(distDir), publicDir)).toEqual([]);
  });

  it('flags a stale hashed chunk nothing references — the shipped 2.2MB regression', () => {
    const { distDir, publicDir } = makeFixture({
      'index.html': '<script src="/assets/index-Abc123.js"></script>',
      'assets/index-Abc123.js': 'console.log("app")',
      'assets/index-Stale99.js': 'console.log("previous build")',
    });
    expect(findStaleAssets(distDir, walk(distDir), publicDir)).toEqual(['assets/index-Stale99.js']);
  });

  it('trusts public/-copied files even when only runtime-constructed paths address them', () => {
    const { distDir, publicDir } = makeFixture(
      {
        'index.html': '<script src="/assets/index-Abc123.js"></script>',
        'assets/index-Abc123.js': 'const href = `/favicon-${theme}.svg`',
        'favicon-sage.svg': '<svg/>',
        'fonts/GeistMono-LICENSE.txt': 'license text',
      },
      ['favicon-sage.svg', 'fonts/GeistMono-LICENSE.txt'],
    );
    expect(findStaleAssets(distDir, walk(distDir), publicDir)).toEqual([]);
  });

  it('flags a dist file that was removed from public/ and is otherwise unreferenced', () => {
    const { distDir, publicDir } = makeFixture(
      {
        'index.html': '<script src="/assets/index-Abc123.js"></script>',
        'assets/index-Abc123.js': 'console.log("app")',
        'favicon-retired.svg': '<svg/>',
      },
      ['favicon-sage.svg'],
    );
    expect(findStaleAssets(distDir, walk(distDir), publicDir)).toEqual(['favicon-retired.svg']);
  });

  it('returns nothing when index.html is absent (empty-map warning path owns that case)', () => {
    const { distDir, publicDir } = makeFixture({
      'assets/index-Orphan1.js': 'console.log("no entry")',
    });
    expect(findStaleAssets(distDir, walk(distDir), publicDir)).toEqual([]);
  });
});
