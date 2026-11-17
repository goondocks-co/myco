/**
 * The Deployment's dashboard reaches the compiled binary as bytes.
 *
 * The binary ships without an adjacent build tree, so the dashboard travels as
 * a generated module of base64 files. An empty module compiles, links, and
 * serves nothing — a blank page at every route, with every other build step
 * green. The generator refuses to write one; this refuses to ship one that was
 * written before it did.
 *
 * The test runner prepares the same source-built carrier the release embeds.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, utimesSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emitBundle, prepareDashboard, type UiBundle } from '@myco/../scripts/gen-ui-assets.js';
import { BUNDLED_SERVER_UI } from '@myco/server-ui-assets.generated.js';
import { withStaticMap } from '@myco-server-worker/platform/bun/static.js';

const serve = (bundle: Readonly<Record<string, string>>) => withStaticMap(Object.fromEntries(Object.entries(bundle)
  .map(([key, value]) => [key, new Uint8Array(Buffer.from(value, 'base64'))])), async () => new Response(null, { status: 401 }));

describe('the dashboard a compiled binary carries', () => {
  it('embeds relative assets and serves the built shell and its script on a deep route', async () => {
    expect(BUNDLED_SERVER_UI['index.html']!.length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(BUNDLED_SERVER_UI)) {
      expect({ key, leading: key.startsWith('/'), backslash: key.includes('\\') }).toEqual({ key, leading: false, backslash: false });
      expect(() => Buffer.from(value, 'base64')).not.toThrow();
    }
    const handle = serve(BUNDLED_SERVER_UI);
    const response = await handle(new Request('http://localhost/p/example/sessions'));
    expect(response.status).toBe(200);
    const shell = await response.text();
    expect(shell).toContain('id="root"');
    const script = /src="([^"]+\.js)"/.exec(shell)![1]!;
    expect(script).toStartWith('/assets/');
    const asset = await handle(new Request(new URL(script, 'http://localhost')));
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await asset.text()).length).toBeGreaterThan(0);
  });
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

  it('refuses an absent build instead of writing an empty map', () => {
    const bundle = bundleAt(scratch());
    expect(() => emitBundle(bundle)).toThrow('Run `npm run build:ui` from the repository root.');
  });

  it('reuses an unchanged build and serves changed source even when its timestamp is preserved', async () => {
    const root = scratch();
    const bundle = bundleAt(root);
    const source = join(root, 'source.html');
    const writeSource = (text: string) => { writeFileSync(source, text); utimesSync(source, 1, 1); };
    const build = () => {
      mkdirSync(bundle.uiDir, { recursive: true });
      writeFileSync(join(bundle.uiDir, 'index.html'), readFileSync(source));
    };
    const prepare = () => prepareDashboard({ bundle, inputs: [source], build });
    writeSource('<html>first</html>');
    prepare();
    prepareDashboard({ bundle, inputs: [source], build: () => { throw new Error('unchanged source rebuilt'); } });
    writeSource('<html>second</html>');
    prepare();
    const assets = (await import(`${bundle.outputPath}?current`)).BUNDLED_TEST_UI as Record<string, string>;
    const handle = serve(assets);
    expect(await (await handle(new Request('http://localhost/'))).text()).toBe('<html>second</html>');
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

  it('leaves identical generated bytes untouched and writes changed assets', () => {
    const bundle = bundleAt(scratch());
    mkdirSync(bundle.uiDir, { recursive: true });
    const shell = join(bundle.uiDir, 'index.html');
    writeFileSync(shell, '<html>dashboard</html>');
    emitBundle(bundle);
    const timestamp = new Date('2000-01-01T00:00:00Z');
    utimesSync(bundle.outputPath, timestamp, timestamp);
    const before = statSync(bundle.outputPath).mtimeMs;

    emitBundle(bundle);
    expect(statSync(bundle.outputPath).mtimeMs).toBe(before);

    writeFileSync(shell, '<html>changed dashboard</html>');
    emitBundle(bundle);
    expect(readFileSync(bundle.outputPath, 'utf8')).toContain(Buffer.from('<html>changed dashboard</html>').toString('base64'));
  });
});
