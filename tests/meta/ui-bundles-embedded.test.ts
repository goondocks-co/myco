/**
 * Both dashboards reach the compiled binary as bytes.
 *
 * The binary ships without an adjacent build tree, so each dashboard travels as
 * a generated module of base64 files. An empty module compiles, links, and
 * serves nothing — a blank page at every route, with every other build step
 * green. The generator refuses to write one; this refuses to ship one that was
 * written before it did.
 *
 * Committed artifacts, so this reads what a release would carry rather than
 * what a local build happens to have produced.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { emitBundle, type UiBundle } from '@myco/../scripts/gen-ui-assets.js';
import { BUNDLED_UI } from '@myco/ui-assets.generated.js';
import { BUNDLED_SERVER_UI } from '@myco/server-ui-assets.generated.js';

const BUNDLES: Array<[string, Readonly<Record<string, string>>]> = [
  ['member dashboard', BUNDLED_UI],
  ['Deployment dashboard', BUNDLED_SERVER_UI],
];

describe('the dashboards a compiled binary carries', () => {
  for (const [name, bundle] of BUNDLES) {
    it(`embeds the ${name} with a shell and its assets`, () => {
      const keys = Object.keys(bundle);
      expect({ name, hasShell: keys.includes('index.html') }).toEqual({ name, hasShell: true });
      // A shell alone is a page with no script; the build always produces both.
      expect(keys.some((key) => key.startsWith('assets/') && key.endsWith('.js'))).toBe(true);
      expect(bundle['index.html']!.length).toBeGreaterThan(0);
    });

    it(`stores every ${name} file as decodable base64 under a relative key`, () => {
      for (const [key, value] of Object.entries(bundle)) {
        expect({ key, leading: key.startsWith('/'), backslash: key.includes('\\') })
          .toEqual({ key, leading: false, backslash: false });
        expect(() => Buffer.from(value, 'base64')).not.toThrow();
      }
    });
  }
});

/**
 * The generator refuses an absent build.
 *
 * An empty map compiles and links, so the failure it used to produce was a
 * binary serving a blank page with every build step green. The refusal is what
 * makes that a failed build, and this is what keeps the refusal.
 */
describe('the generator that embeds a dashboard', () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
  const scratch = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'myco-genui-'));
    roots.push(root);
    return root;
  };

  const bundleAt = (root: string): UiBundle => ({
    name: 'test dashboard',
    uiDir: join(root, 'dist'),
    publicDir: join(root, 'public'),
    outputPath: join(root, 'out.generated.ts'),
    exportName: 'BUNDLED_TEST_UI',
    origin: 'dist/',
  });

  it('rebuilds the Deployment dashboard from changed source before embedding an incremental build', () => {
    const root = scratch();
    const member = join(root, 'packages', 'myco');
    const server = join(root, 'packages', 'myco-server');
    const scripts = JSON.parse(readFileSync(new URL('../../packages/myco/package.json', import.meta.url), 'utf8')).scripts;
    mkdirSync(member, { recursive: true });
    mkdirSync(join(server, 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    writeFileSync(join(member, 'package.json'), JSON.stringify({ name: '@goondocks/myco', scripts: {
      'build:ui': scripts['build:ui'], 'build:ui:member': 'node build.cjs',
    } }));
    writeFileSync(join(member, 'build.cjs'), '');
    writeFileSync(join(server, 'package.json'), JSON.stringify({ name: '@goondocks/myco-server', scripts: { 'build:ui': 'node build.cjs' } }));
    writeFileSync(join(server, 'build.cjs'), "require('node:fs').copyFileSync('source.html', 'dist/index.html');");
    writeFileSync(join(server, 'source.html'), '<html>updated source</html>');
    writeFileSync(join(server, 'dist', 'index.html'), '<html>previous build</html>');

    const result = spawnSync('npm', ['run', 'build:ui', '-w', '@goondocks/myco'], {
      cwd: root, encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32',
    });
    if (result.status !== 0) throw new Error(`UI build failed: ${result.error ?? result.stderr}`);
    const bundle = bundleAt(server);
    emitBundle(bundle);
    const generated = readFileSync(bundle.outputPath, 'utf8');
    expect(generated).toContain(Buffer.from('<html>updated source</html>').toString('base64'));
    expect(generated).not.toContain(Buffer.from('<html>previous build</html>').toString('base64'));
  });

  it('refuses an absent build instead of writing an empty map', () => {
    const bundle = bundleAt(scratch());
    expect(() => emitBundle(bundle)).toThrow(/absent/);
  });

  it('writes the files a present build holds, under their relative keys', () => {
    const root = scratch();
    const bundle = bundleAt(root);
    mkdirSync(bundle.uiDir, { recursive: true });
    mkdirSync(join(bundle.uiDir, 'assets'), { recursive: true });
    writeFileSync(join(bundle.uiDir, 'index.html'), '<!doctype html><script src="/assets/app-1.js"></script>');
    writeFileSync(join(bundle.uiDir, 'assets', 'app-1.js'), 'export const a = 1;');

    expect(emitBundle(bundle)).toBe(2);
    const written = readFileSync(bundle.outputPath, 'utf-8');
    expect(written).toContain('BUNDLED_TEST_UI');
    expect(written).toContain('index.html');
    expect(written).toContain('assets/app-1.js');
  });
});
