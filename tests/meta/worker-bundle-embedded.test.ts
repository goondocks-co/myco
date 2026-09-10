/**
 * The Cloudflare Worker a compiled binary deploys.
 *
 * Provisioning holds no checkout, so the Worker travels inside the binary. It
 * is built rather than committed, which puts two failures in reach that nothing
 * else catches: a module that built empty, and a module built by a different
 * bundler than the one the lockfile pins. An empty one compiles, links, and
 * deploys a Worker that serves nothing.
 *
 * The generator's freshness decision is exercised in a scratch tree, because it
 * is what makes `prelint` and `pretest` free on an unchanged clone — and an
 * over-eager skip is how a fresh clone gets no module at all.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleConfig, bundleIsStale, pinnedWranglerVersion } from '../../packages/myco/scripts/gen-worker-bundle.js';
import { BUNDLED_WORKER, BUNDLED_WORKER_WRANGLER } from '@myco/worker-bundle.generated.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Set from the bundle measured AFTER #1162 — 1,203,929 bytes decoded, 260,181
 * gzipped — with room for ordinary growth. The figure before that work was
 * 1,196,848, only 3,152 under the previous 1,200,000 ceiling, which is why a
 * page's worth of new server code tripped it.
 *
 * The ceiling is a tripwire, not a platform budget: Cloudflare enforces 64 MiB
 * uncompressed on every plan, so this exists to catch a bundler that starts
 * carrying files it does not belong to, rather than to keep a deploy legal. The
 * staged-directory sweep that carried 31 extra modules cost 65 KiB, and the
 * headroom stays under that, so a sweep of that shape still trips this while
 * ordinary growth does not.
 */
const SIZE_CEILING_BYTES = 1_260_000;

const decoded = (): string => Buffer.from(BUNDLED_WORKER, 'base64').toString('utf-8');

describe('the Worker a compiled binary carries', () => {
  it('is a non-empty module exporting what the deployed configuration binds', () => {
    const js = decoded();
    expect(js.length).toBeGreaterThan(1000);
    // The entry the config names and the Durable Object it declares a class for;
    // a deploy binding a class the script does not export is refused outright.
    for (const named of ['handleRequest', 'DeploymentClock']) expect(js).toContain(named);
    expect(js).toMatch(/export\s*\{/);
  });

  it('GATE: carries no container, so the deploy stays on surfaces the free plan serves', () => {
    const js = decoded();
    expect(js).not.toContain('HarnessContainer');
    expect(js).not.toContain('@cloudflare/containers');
  });

  it('carries no reference to a source map no deploy ships', () => {
    expect(decoded()).not.toContain('sourceMappingURL');
  });

  it('stays under the size ceiling', () => {
    expect(Buffer.byteLength(decoded(), 'utf-8')).toBeLessThan(SIZE_CEILING_BYTES);
  });

  it('GATE: was built by the wrangler the lockfile pins, so a bump fails by name', () => {
    // The module records the bundler that actually produced it, which is the
    // only fact worth comparing: reading the lockfile twice compares nothing.
    expect(BUNDLED_WORKER_WRANGLER).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUNDLED_WORKER_WRANGLER).toBe(pinnedWranglerVersion());
  });

  it('builds against the configuration minus its assets table, which a source-only tree cannot satisfy', () => {
    const toml = readFileSync(path.join(REPO_ROOT, 'packages', 'myco-server', 'wrangler.toml'), 'utf-8');
    const stripped = bundleConfig(toml);
    expect(toml).toContain('[assets]');
    expect(stripped).not.toContain('[assets]');
    expect(stripped).not.toContain('directory = "ui/dist"');
    // Everything else the bundler reads is untouched.
    for (const kept of ['main = "src/index.ts"', 'compatibility_date', '[[d1_databases]]']) expect(stripped).toContain(kept);
  });
});

describe('the hooks that give a fresh clone the module before anything reads it', () => {
  it('GATE: lint and test both build it first', () => {
    // Nothing else does. `codegen` produces it, but a fresh clone's first
    // command is usually one of these two, and the typechecker reads the module
    // the staging path imports.
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    for (const hook of ['prelint', 'pretest']) {
      expect({ hook, builds: (manifest.scripts[hook] ?? '').includes('gen-worker-bundle') }).toEqual({ hook, builds: true });
    }
  });
});

describe('the freshness decision that makes those hooks free', () => {
  const scratch = () => mkdtempSync(path.join(tmpdir(), 'myco-bundle-stale-'));

  const at = (file: string, seconds: number): string => {
    writeFileSync(file, 'x');
    utimesSync(file, seconds, seconds);
    return file;
  };

  it('rebuilds when the module is absent, which is every fresh clone', () => {
    const root = scratch();
    expect(bundleIsStale(path.join(root, 'absent.generated.ts'), [at(path.join(root, 'input.ts'), 1000)])).toBe(true);
  });

  it('rebuilds when an input is newer, and when an input is exactly as new', () => {
    const root = scratch();
    const out = at(path.join(root, 'out.generated.ts'), 1000);
    expect(bundleIsStale(out, [at(path.join(root, 'newer.ts'), 2000)])).toBe(true);
    // Equal times count as stale: the answer errs toward building a bundle that
    // was already current rather than shipping one that was not.
    expect(bundleIsStale(out, [at(path.join(root, 'same.ts'), 1000)])).toBe(true);
  });

  it('skips only when every input is older than the module', () => {
    const root = scratch();
    const older = at(path.join(root, 'older.ts'), 1000);
    const out = at(path.join(root, 'out.generated.ts'), 3000);
    expect(bundleIsStale(out, [older])).toBe(false);
  });
});
