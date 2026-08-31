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

  it('drops the container tables a local boot cannot serve, which the committed file carries', () => {
    expect(WRANGLER_TEMPLATE).toContain('[[containers]]');
    expect(WRANGLER_TEMPLATE).toContain('class_name = "HarnessContainer"');
    const config = parityWranglerConfig();
    for (const dropped of ['[[containers]]', '[[durable_objects.bindings]]', '[[migrations]]', 'HARNESS']) {
      expect(config).not.toContain(dropped);
    }
  });
});
