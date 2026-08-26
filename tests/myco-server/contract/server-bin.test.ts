/**
 * The self-hosted process entry.
 *
 * Two things are asserted here that nothing else covers:
 *
 * `migrateOnly` is the only production path that applies migrations for this
 * target. Every other caller of the migration renderer is a test, and the
 * request handler refuses a volume that is behind rather than migrating it, so
 * this function is what makes a self-hosted deployment servable at all.
 *
 * The startup refusals turn a per-request failure into one startup failure. A
 * deployment declaring a proxy source without a trusted header, or with fewer
 * than one trusted hop, establishes no source identity at all
 * (`platform/bun/source.ts:59`), and the core answers 503 to every request
 * while the container reports healthy.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';

const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'myco-bun-main-'));
  roots.push(root);
  return root;
};
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const TOUCHED = [
  'MYCO_BIND',
  'MYCO_DATABASE', 'MYCO_BLOB_DIR', 'MYCO_PORT', 'MYCO_TRANSPORT',
  'MYCO_SOURCE_FROM', 'MYCO_TRUSTED_HEADER', 'MYCO_TRUSTED_HOPS',
  'SECRET_WRAP_KEY', 'SECRET_WRAP_KEY_FILE',
] as const;
afterEach(() => { for (const key of TOUCHED) delete process.env[key]; });

describe('migrateOnly', () => {
  it('brings a fresh volume to a servable schema', () => {
    const path = join(scratch(), 'myco.sqlite');
    migrateOnly(path);

    const sqlite = new Database(path);
    const tables = sqlite.query(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all() as { name: string }[];
    sqlite.close();

    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((t) => t.name)).toContain('projects');
  });

  it('is idempotent — the entrypoint runs it on every container start', () => {
    const path = join(scratch(), 'myco.sqlite');
    const first = migrateOnly(path);
    expect(first).toBeGreaterThan(0);

    // A second pass applies nothing, leaving the CREATE TABLE statements alone.
    expect(migrateOnly(path)).toBe(0);
    expect(migrateOnly(path)).toBe(0);
  });

  it('applies only the steps a partially-migrated volume is behind', () => {
    const path = join(scratch(), 'myco.sqlite');
    const total = migrateOnly(path);

    // Wind the stamp back one step; only that step should re-apply.
    const sqlite = new Database(path);
    sqlite.query(`UPDATE schema_meta SET value = ? WHERE key = 'version'`).run(String(total - 1));
    sqlite.close();

    expect(migrateOnly(path)).toBe(1);
  });
});

describe('startup refusals', () => {
  const volume = () => {
    const root = scratch();
    return { MYCO_DATABASE: join(root, 'myco.sqlite'), MYCO_BLOB_DIR: join(root, 'blobs') };
  };

  it('refuses an unknown transport rather than defaulting to one', async () => {
    Object.assign(process.env, volume(), { MYCO_TRANSPORT: 'public' });
    await expect(main()).rejects.toThrow(/MYCO_TRANSPORT/);
  });

  it('refuses a proxy source with no trusted header', async () => {
    Object.assign(process.env, volume(), { MYCO_SOURCE_FROM: 'proxy' });
    await expect(main()).rejects.toThrow(/MYCO_TRUSTED_HEADER/);
  });

  it('refuses a proxy source with zero trusted hops, which establishes no identity', async () => {
    Object.assign(process.env, volume(), {
      MYCO_SOURCE_FROM: 'proxy',
      MYCO_TRUSTED_HEADER: 'x-forwarded-for',
      MYCO_TRUSTED_HOPS: '0',
    });
    await expect(main()).rejects.toThrow(/MYCO_TRUSTED_HOPS/);
  });

  it('refuses a missing database path', async () => {
    process.env.MYCO_BLOB_DIR = join(scratch(), 'blobs');
    await expect(main()).rejects.toThrow(/MYCO_DATABASE/);
  });

  it('refuses a non-numeric port instead of silently falling back', async () => {
    Object.assign(process.env, volume(), { MYCO_PORT: 'eight-thousand' });
    await expect(main()).rejects.toThrow(/MYCO_PORT/);
  });
});

describe('secrets arrive as files', () => {
  it('reads a value from the file its *_FILE variable names', async () => {
    const root = scratch();
    const secretPath = join(root, 'wrap_key');
    writeFileSync(secretPath, '  dGVzdC1rZXk=  \n');
    process.env.SECRET_WRAP_KEY_FILE = secretPath;
    process.env.MYCO_DATABASE = join(root, 'myco.sqlite');
    process.env.MYCO_BLOB_DIR = join(root, 'blobs');
    process.env.MYCO_PORT = '0';
    migrateOnly(process.env.MYCO_DATABASE);

    // A clean start proves the file is read and trimmed, not passed through
    // with its surrounding whitespace.
    const started = await main();
    expect(started).toBeUndefined();
  });

  it('refuses when *_FILE names a file it cannot read', async () => {
    const root = scratch();
    process.env.SECRET_WRAP_KEY_FILE = join(root, 'absent');
    process.env.MYCO_DATABASE = join(root, 'myco.sqlite');
    process.env.MYCO_BLOB_DIR = join(root, 'blobs');
    await expect(main()).rejects.toThrow(/SECRET_WRAP_KEY_FILE/);
  });
});

describe('bind mode', () => {
  it('refuses an unknown bind mode rather than defaulting to one', async () => {
    const root = scratch();
    Object.assign(process.env, {
      MYCO_DATABASE: join(root, 'myco.sqlite'),
      MYCO_BLOB_DIR: join(root, 'blobs'),
      MYCO_BIND: 'everywhere',
    });
    await expect(main()).rejects.toThrow(/MYCO_BIND/);
  });
});
