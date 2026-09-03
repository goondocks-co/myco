/**
 * The embedded template and the committed Worker configuration are one
 * artifact. `myco server config` renders the deploy config from the embedded
 * copy, and wrangler reads the file: two sources means a binding can be
 * corrected in one and stay wrong in the other, with each half green alone.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WRANGLER_TEMPLATE } from '@myco/server/wrangler-template.js';
import { DeployConfigIncomplete, parityWranglerConfig, renderDeployConfig } from '@myco/server/deploy-config.js';
import { harnessImageUri } from '@myco/server/cloudflare.js';
import type { DeploymentRecord } from '@myco/server/cloudflare.js';

const SHIPPED = fileURLToPath(new URL('../../packages/myco-server/wrangler.toml', import.meta.url));

const record = (over: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  accountId: 'a'.repeat(32),
  workerName: 'myco-server',
  databaseName: 'myco-server',
  bucketName: 'myco-server-blobs',
  versionId: null,
  deployedAt: '2026-08-31T00:00:00Z',
  ...over,
});

describe('wrangler template', () => {
  it('is byte-identical to the committed Worker configuration', () => {
    expect(WRANGLER_TEMPLATE).toBe(readFileSync(SHIPPED, 'utf8'));
  });

  it('carries the placeholder the renderer substitutes, exactly once', () => {
    // The renderer substitutes the first occurrence; a second would ship half-substituted.
    expect(WRANGLER_TEMPLATE.split('<YOUR_D1_DATABASE_ID>').length).toBe(2);
  });
});

describe('renderDeployConfig', () => {
  it('renders the account, custom-domain route, database id, and secrets store from the record', () => {
    const config = renderDeployConfig(record({ url: 'https://myco.example.com', databaseId: 'd1-uuid', storeId: 'store-1' }));
    const lines = config.split('\n');
    expect(lines[0]).toBe(`account_id = "${'a'.repeat(32)}"`);
    expect(lines[1]).toBe('routes = [ { pattern = "myco.example.com", custom_domain = true } ]');
    expect(config).toContain('database_id = "d1-uuid"');
    expect(config).not.toContain('<YOUR_D1_DATABASE_ID>');
    expect(config).toContain('store_id = "store-1"');
    // The activated block joins the commented declaration; both name the same secret.
    expect(config.split('secret_name = "myco-secret-wrap-key"').length).toBe(3);
  });

  it('renders no route for a workers.dev URL and no store block without a store id', () => {
    const config = renderDeployConfig(record({ url: 'https://myco.example.workers.dev', databaseId: 'd1-uuid' }));
    expect(config).not.toContain('routes =');
    expect(config.split('\n')[1]).toBe('name = "myco-server"');
    expect(config).not.toContain('\nstore_id =');
  });

  it('refuses a record without the database id, naming the missing field', () => {
    expect(() => renderDeployConfig(record())).toThrow(DeployConfigIncomplete);
    try {
      renderDeployConfig(record());
    } catch (err) {
      expect((err as DeployConfigIncomplete).missing).toEqual(['databaseId']);
      expect((err as Error).message).toContain('databaseId');
    }
  });
});

describe('parityWranglerConfig', () => {
  it('drops exactly the public-fetch flag and the assets table, keeping every binding', () => {
    const config = parityWranglerConfig();
    expect(config).not.toContain('global_fetch_strictly_public');
    // The table is dropped; its preceding comment block may mention the keys.
    expect(config).not.toMatch(/^\[assets\]/m);
    expect(config).not.toMatch(/^run_worker_first/m);
    expect(config).not.toContain('directory = "ui/dist"');
    for (const kept of ['[[d1_databases]]', '[[r2_buckets]]', 'SOURCE_LIMIT', 'TOKEN_LIMIT']) {
      expect(config).toContain(kept);
    }
  });

  it('drops the container tables a local boot cannot serve, which the committed file carries, and keeps the clock', () => {
    expect(WRANGLER_TEMPLATE).toContain('[[containers]]');
    expect(WRANGLER_TEMPLATE).toContain('class_name = "HarnessContainer"');
    expect(WRANGLER_TEMPLATE).toContain('class_name = "DeploymentClock"');
    const config = parityWranglerConfig();
    for (const dropped of ['[[containers]]', 'HARNESS', 'HarnessContainer', 'v1-harness']) {
      expect(config).not.toContain(dropped);
    }
    for (const kept of ['[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '[[migrations]]', 'tag = "v2-clock"', '[triggers]']) {
      expect(config).toContain(kept);
    }
    // One binding table and one migration table survive: the clock's.
    expect(config.match(/^\[\[durable_objects\.bindings\]\]$/gm)).toHaveLength(1);
    expect(config.match(/^\[\[migrations\]\]$/gm)).toHaveLength(1);
  });
});

describe('harness image pinning', () => {
  const ACCOUNT = 'a'.repeat(32);
  const URI = `registry.cloudflare.com/${ACCOUNT}/myco-server-harnesscontainer@sha256:${'b'.repeat(64)}`;

  it('pins the record image over the Dockerfile form, and keeps the Dockerfile form on a record without one', () => {
    const pinned = renderDeployConfig(record({ databaseId: 'd1-uuid', harnessImage: URI }));
    expect(pinned).toContain(`image = "${URI}"`);
    expect(pinned).not.toContain('image = "./harness/Dockerfile"');
    const unpinned = renderDeployConfig(record({ databaseId: 'd1-uuid' }));
    expect(unpinned).toContain('image = "./harness/Dockerfile"');
  });

  it('refuses a harnessImage that is not a digest-pinned registry URI, naming the record', () => {
    expect(() => renderDeployConfig(record({ databaseId: 'd1-uuid', harnessImage: 'myco-server-harnesscontainer:latest' })))
      .toThrow(/harnessImage.*record\.json/);
  });

  it('composes the URI from the LAST exported manifest digest', () => {
    const out = [
      `#12 exporting manifest sha256:${'c'.repeat(64)} done`,
      `#12 exporting manifest sha256:${'d'.repeat(64)} done`,
      'Image already exists remotely, skipping push',
    ].join('\n');
    expect(harnessImageUri(out, ACCOUNT, 'myco-server')).toBe(`registry.cloudflare.com/${ACCOUNT}/myco-server-harnesscontainer@sha256:${'d'.repeat(64)}`);
  });

  it('derives the image name suffix from the template container class', () => {
    const cls = /class_name = "([A-Za-z0-9]+)"/.exec(WRANGLER_TEMPLATE.split('[[containers]]')[1]!)?.[1];
    expect(cls).toBe('HarnessContainer');
    const out = `#12 exporting manifest sha256:${'c'.repeat(64)} done`;
    expect(harnessImageUri(out, ACCOUNT, 'w')).toContain(`/w-${cls!.toLowerCase()}@sha256:`);
  });

  it('refuses build output with no manifest digest', () => {
    expect(() => harnessImageUri('Login Succeeded', ACCOUNT, 'myco-server')).toThrow(/manifest digest/);
  });
});
