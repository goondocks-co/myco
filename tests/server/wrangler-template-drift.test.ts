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
import { DeployConfigIncomplete, FREE_TIER_SURFACES, migrationLedger, parityWranglerConfig, renderDeployConfig, undeletableClasses } from '@myco/server/deploy-config.js';
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

  it('declares only surfaces the free plan serves, and retires the class it no longer exports', () => {
    // Containers are a paid-plan surface, and the Deployment is meant to run on
    // the free one. A class this Worker no longer exports keeps its lifecycle
    // entry so the platform is told the namespace is gone, once.
    expect(WRANGLER_TEMPLATE).not.toContain('[[containers]]');
    expect(WRANGLER_TEMPLATE).not.toContain('name = "HARNESS"');
    // The rendered config is what deploys, so it is what is checked: the
    // template alone misses the vector bindings and the store block the
    // renderer appends.
    const rendered = renderDeployConfig(record({ databaseId: 'd1-uuid', storeId: 'store-1', url: 'https://myco.example.com' }));
    const headers = (text: string) => [...text.matchAll(/^(\[\[?[a-z0-9_.]+\]?\])$/gm)].map((m) => m[1]!);
    // Nothing ships that is not on the list, in the committed base or in what
    // a deploy actually reads.
    expect(headers(WRANGLER_TEMPLATE).filter((table) => !FREE_TIER_SURFACES.includes(table as never))).toEqual([]);
    expect(headers(rendered).filter((table) => !FREE_TIER_SURFACES.includes(table as never))).toEqual([]);
    // And nothing is on the list that no longer ships, so a retired surface
    // cannot sit here granting silent permission to a future one.
    const shipped = new Set([...headers(WRANGLER_TEMPLATE), ...headers(rendered)]);
    expect(FREE_TIER_SURFACES.filter((table) => !shipped.has(table))).toEqual([]);
    expect(WRANGLER_TEMPLATE).toContain('deleted_classes = [ "HarnessContainer" ]');
    expect(WRANGLER_TEMPLATE.match(/deleted_classes/g)).toHaveLength(1);
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

  it('tells the Worker the fleet and the origin the record names, and refuses a fleet that is not a count', () => {
    const config = renderDeployConfig(record({ url: 'https://myco.example.com', databaseId: 'd1-uuid', fleet: 3 }));
    expect(config).toContain('[vars]');
    expect(config).toContain('MYCO_ORIGIN = "https://myco.example.com"');
    expect(config).toContain('MYCO_FLEET = "3"');
    expect(config.match(/^\[vars\]$/gm)).toHaveLength(1);
    expect(renderDeployConfig(record({ databaseId: 'd1-uuid' }))).not.toContain('[vars]');
    expect(() => renderDeployConfig(record({ databaseId: 'd1-uuid', fleet: 0 }))).toThrow(/fleet/);
    expect(() => renderDeployConfig(record({ databaseId: 'd1-uuid', fleet: 2.5 }))).toThrow(/fleet/);
  });

  it('runs the carried bundle, alone in its own directory, with wrangler bundling nothing and sweeping nothing', () => {
    // `no_bundle` turns `find_additional_modules` on by default, which would
    // carry the staged dashboard and migrations into the Worker script.
    const config = renderDeployConfig(record({ databaseId: 'd1-uuid' }));
    expect(config).toContain('main = "worker/worker.js"');
    expect(config).toContain('no_bundle = true');
    expect(config).toContain('find_additional_modules = false');
    expect(config).not.toContain('main = "src/index.ts"');
    // Nothing in a deploy names an image: the deploy ships code, never a container.
    expect(config).not.toMatch(/^image = /m);
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

  it('carries the whole class-lifecycle ledger, so a local boot applies what a deploy applies', () => {
    // The ledger rode into parity stripped once, which is how a delete of a
    // class the history never created reached main: the suite booted a config
    // the deploy never uses.
    expect(WRANGLER_TEMPLATE).toContain('class_name = "DeploymentClock"');
    expect(WRANGLER_TEMPLATE).toContain('deleted_classes = [ "HarnessContainer" ]');
    const config = parityWranglerConfig();
    expect(migrationLedger(config)).toEqual(migrationLedger(WRANGLER_TEMPLATE));
    for (const kept of ['[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '[[migrations]]', 'tag = "v2-clock"', '[triggers]']) {
      expect(config).toContain(kept);
    }
    // One binding table survives — the clock's; the class it retired has none.
    expect(config.match(/^\[\[durable_objects\.bindings\]\]$/gm)).toHaveLength(1);
  });

  it('GATE: deletes no class the ledger never created, on either the committed base or a rendered deploy', () => {
    // Applied in order from the instance's own recorded tag: a delete naming a
    // class the history never created is refused, and the instance never
    // starts — a fresh local boot and a Deployment created after the class was
    // retired fail the same way. Retiring means appending a delete, never
    // removing the entry that created it.
    expect(undeletableClasses(WRANGLER_TEMPLATE)).toEqual([]);
    expect(undeletableClasses(parityWranglerConfig())).toEqual([]);
    expect(undeletableClasses(renderDeployConfig(record({ databaseId: 'd1-uuid' })))).toEqual([]);
    // The shape it exists to refuse.
    expect(undeletableClasses('[[migrations]]\ntag = "v9"\ndeleted_classes = [ "Gone" ]')).toEqual(['Gone']);
  });
});
