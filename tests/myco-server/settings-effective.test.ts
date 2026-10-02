/**
 * What the settings surface reports as in effect, through the shipped request handler on each target: the hosted
 * embedding default with nothing stored, a stored provider the target does not offer, every self-hosted provider's
 * exact defaults, values refused before storage, reset back to the effective default, and an embedding model whose
 * vectors would not compare with the ones search holds.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import worker from '@myco-server-worker/index.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { DEPLOYMENT_LEAF_SPECS, DEPLOYMENT_LEAVES, RETIRED_LEAVES } from '@myco-server-worker/core/settings.js';
import { seededSqlite } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, asOwnerPut, OWNER_ENV } from './helpers/owner.js';
import type { Database } from 'bun:sqlite';

const WRAP = btoa('e'.repeat(32));
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

interface Target { sqlite: Database; fetch(request: Request): Promise<Response>; env?: ServerEnv }

/** The hosted Worker entry, with a Workers AI binding that answers one vector for any model. */
function hosted(): Target {
  const e = sqliteEnv();
  const bindings = { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP }, AI: { run: async () => ({ data: [[1, 0]] }) } };
  return { sqlite: e.sqlite, fetch: (request) => worker.fetch(request, bindings, e.deferred) };
}

/** The self-hosted server over its own store. */
function selfHosted(): Target {
  const sqlite = seededSqlite();
  const dir = mkdtempSync(path.join(tmpdir(), 'myco-settings-effective-'));
  temporary.push(dir);
  const env = serverEnvFromBunConfig({ sqlite, blobDir: path.join(dir, 'blobs'), ...OWNER_ENV, SECRET_WRAP_KEY: WRAP });
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  return { sqlite, env, fetch: (request) => server.handleRequest(request, env) };
}

const json = async (response: Response): Promise<Record<string, unknown>> => response.json() as Promise<Record<string, unknown>>;
const put = async (t: Target, leaf: string, value: unknown) => t.fetch(await asOwnerPut(`/api/settings/${leaf}`, { value }));
const reset = async (t: Target, leaf: string) =>
  t.fetch(new Request(`https://s/api/settings/${leaf}`, { method: 'DELETE', headers: Object.fromEntries((await asOwnerPost(`/api/settings/${leaf}`)).headers) }));
async function rows(t: Target): Promise<Map<string, Record<string, unknown>>> {
  const answer = await json(await t.fetch(await asOwner('/api/settings')));
  return new Map((answer.leaves as Array<Record<string, unknown>>).map((row) => [String(row.leaf), row]));
}
const stored = (t: Target, leaf: string): unknown => {
  const held = t.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf = ?`).get(leaf) as { value: string } | null;
  return held === null ? undefined : JSON.parse(held.value);
};

describe('embedding in effect', () => {
  it('names Workers AI with bge-m3 on a hosted Deployment that stores nothing', async () => {
    const t = hosted();
    const leaves = await rows(t);
    expect(leaves.get('embedding.provider')).toMatchObject({ configured: false, effective: 'workers-ai', state: 'active' });
    expect(leaves.get('embedding.model')).toMatchObject({ configured: false, effective: '@cf/baai/bge-m3', state: 'active' });
    expect(leaves.get('embedding.base_url')).toMatchObject({ configured: false, appliesTo: ['bun'] });
  });

  it('reports a stored Ollama provider on a hosted Deployment as not applicable, with its remedy, and keeps Workers AI in effect', async () => {
    const t = hosted();
    t.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('embedding.provider', '"ollama"', 1, 'historic'), ('embedding.model', '""', 1, 'historic')`);
    const leaves = await rows(t);
    expect(leaves.get('embedding.provider')).toMatchObject({ configured: true, stored: 'ollama', effective: 'workers-ai', state: 'not-applicable', reason: expect.stringContaining('Reset') });
    expect(leaves.get('embedding.model')).toMatchObject({ stored: '', effective: '@cf/baai/bge-m3', state: 'invalid', remedy: expect.stringContaining('Reset') });
    expect((await put(t, 'embedding.provider', 'ollama')).status).toBe(400);
    expect(await json(await reset(t, 'embedding.provider'))).toEqual({ applied: true });
    expect((await rows(t)).get('embedding.provider')).toMatchObject({ configured: false, effective: 'workers-ai', state: 'active' });
  });

  it('resolves each self-hosted provider, unset model and endpoint alike, to its exact defaults and the request identity search uses', async () => {
    const expected: Array<[string, string, string]> = [
      ['ollama', 'bge-m3', 'http://localhost:11434/api/embed'],
      ['lmstudio', 'text-embedding-nomic-embed-text-v1.5', 'http://localhost:1234/v1/embeddings'],
      ['openai', 'text-embedding-3-small', 'https://api.openai.com/v1/embeddings'],
      ['openrouter', 'openai/text-embedding-3-small', 'https://openrouter.ai/api/v1/embeddings'],
    ];
    for (const [provider, model, url] of expected) {
      const t = selfHosted();
      const unset = await rows(t);
      expect(unset.get('embedding.provider')).toMatchObject({ configured: false, effective: null, state: 'inactive' });
      expect(await json(await put(t, 'embedding.provider', provider))).toEqual({ applied: true });
      for (const slot of ['openai', 'openrouter']) {
        await t.fetch(await asOwnerPut(`/api/secrets/${slot}`, { value: `${slot}-key-for-the-test` }));
      }
      const leaves = await rows(t);
      expect({ provider, model: leaves.get('embedding.model')?.effective, source: leaves.get('embedding.model')?.source })
        .toEqual({ provider, model, source: 'default' });
      expect((await t.env!.embeddingProvider!())?.modelKey).toBe(JSON.stringify([provider, model, url]));
    }
    const compatible = selfHosted();
    expect(await json(await put(compatible, 'embedding.provider', 'openai-compatible'))).toEqual({ applied: true });
    expect((await rows(compatible)).get('embedding.base_url')).toMatchObject({ effective: null, state: 'inactive', reason: expect.stringContaining('endpoint') });
    expect(await compatible.env!.embeddingProvider!()).toBeNull();
  });

  it('refuses a model whose vectors would not compare with the ones search holds, and says why', async () => {
    const t = hosted();
    t.sqlite.run(`INSERT INTO embedding_receipts (project_id, model_key, id, type, record_id, revision, ready, updated_at) VALUES ('proj_1', ?, 'v1', 'spore', 's1', 'r1', 1, 1)`,
      [JSON.stringify(['cloudflare', '@cf/baai/bge-m3'])]);
    const leaf = await put(t, 'embedding.model', '@cf/baai/bge-base-en-v1.5');
    expect(leaf.status).toBe(400);
    expect(String((await json(leaf)).detail)).toMatch(/768-dimension.*1024-dimension.*re-index/);
    const whole = await t.fetch(await asOwnerPut('/api/embedding', { provider: 'openrouter', model: 'openai/text-embedding-3-small' }));
    expect(whole.status).toBe(400);
    expect(String((await json(whole)).detail)).toMatch(/1536-dimension.*1024-dimension.*re-index/);
    expect(stored(t, 'embedding.model')).toBeUndefined();
    expect(stored(t, 'embedding.provider')).toBeUndefined();
    const same = await t.fetch(await asOwnerPut('/api/embedding', { provider: 'openrouter', model: 'baai/bge-m3' }));
    expect(await json(same)).toEqual({ applied: true });
    expect([stored(t, 'embedding.provider'), stored(t, 'embedding.model')]).toEqual(['openrouter', 'baai/bge-m3']);
  });
});

describe('values refused before storage', () => {
  it('refuses a blank model, a fractional interval and a malformed endpoint, leaving what was stored', async () => {
    const t = selfHosted();
    expect(await json(await put(t, 'embedding.provider', 'ollama'))).toEqual({ applied: true });
    for (const [leaf, value] of [
      ['embedding.model', ''], ['embedding.model', '   '], ['embedding.base_url', 'not a url'], ['embedding.base_url', 'ftp://models.internal'],
      ['cortex.canopy.refresh.background_period_minutes', 2.5], ['maintenance.auto_optimize_interval_hours', 1.5],
      ['backup.auto_interval_hours', 0.5], ['agent.limits.concurrent_runs', 2.5],
    ] as const) {
      const answer = await put(t, leaf, value);
      expect({ leaf, value, status: answer.status, reason: (await json(answer)).reason }).toEqual({ leaf, value, status: 400, reason: 'invalid_value' });
      expect({ leaf, stored: stored(t, leaf) }).toEqual({ leaf, stored: undefined });
    }
    expect(stored(t, 'embedding.provider')).toBe('ollama');
  });
});

/** A value each live leaf's rule admits on a hosted Deployment. */
function sampleFor(leaf: string): unknown {
  const spec = DEPLOYMENT_LEAF_SPECS[leaf] as Record<string, unknown>;
  if (leaf === 'embedding.model') return '@cf/baai/bge-large-en-v1.5';
  if (leaf === 'embedding.provider') return 'openrouter';
  if (spec.type === 'integer') return spec.max;
  if (spec.type === 'boolean') return true;
  if (spec.type === 'agent') return 'codex';
  if (spec.type === 'agent-list') return ['codex'];
  if (spec.type === 'pattern-list') return ['dist/**'];
  if (spec.type === 'task-overrides') return { 'title-summary': { reasoningLevel: 'high' } };
  if (spec.type === 'profile-model') return spec.harness === 'opencode' ? 'openai/gpt-5' : spec.harness === 'claude-code' ? 'opus' : 'gpt-5';
  if (spec.type === 'profile-effort') return 'low';
  if (spec.type === 'credential-source') return 'worker-login';
  return 'Use the house style.';
}

describe('reset', () => {
  it('restores the effective default of every live leaf a hosted Deployment offers', async () => {
    const t = hosted();
    const before = await rows(t);
    for (const leaf of DEPLOYMENT_LEAVES.filter((l) => !RETIRED_LEAVES.has(l) && l !== 'embedding.base_url')) {
      expect({ leaf, written: await json(await put(t, leaf, sampleFor(leaf))) }).toEqual({ leaf, written: { applied: true } });
      expect({ leaf, reset: await json(await reset(t, leaf)) }).toEqual({ leaf, reset: { applied: true } });
      const after = (await rows(t)).get(leaf)!;
      expect({ leaf, configured: after.configured, effective: after.effective, source: after.source })
        .toEqual({ leaf, configured: false, effective: before.get(leaf)!.effective, source: before.get(leaf)!.source });
      expect(before.get(leaf)!.effective).not.toBeUndefined();
    }
  });
});
