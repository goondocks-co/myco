import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILE_HARNESSES } from '@goondocks/myco-shared/execution-profile';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { dispatchTask, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { seededSqlite } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import type { Database } from 'bun:sqlite';

const WRAP_KEY = btoa('w'.repeat(32));
const TEST_KEY = 'sk-ant-test-container-probe';
const MODEL_LEAF = 'agent.reasoning_map.claude-code.default';
const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function rig(target: 'cloudflare' | 'bun') {
  const launches: Array<{ envVars: Record<string, string> }> = [];
  const launch = async (spec: { envVars: Record<string, string> }) => { launches.push(spec); };
  let sqlite: Database;
  let env: ServerEnv;
  if (target === 'cloudflare') {
    const hosted = sqliteEnv();
    sqlite = hosted.sqlite;
    env = { ...serverEnvFromBindings({ ...hosted.env, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } } as never), harnessLaunch: launch };
  } else {
    sqlite = seededSqlite();
    const blobDir = mkdtempSync(join(tmpdir(), 'myco-probe-retirement-'));
    temporary.push(blobDir);
    env = serverEnvFromBunConfig({ sqlite, blobDir, SECRET_WRAP_KEY: WRAP_KEY, harnessLaunch: launch });
  }
  const legacy = (leaf: string, value: unknown) => sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'old')`).run(leaf, JSON.stringify(value));
  const key = deploymentSecretStore(env.db, env.wrappingKey);
  return { sqlite, env, launches, legacy, key };
}

for (const target of ['cloudflare', 'bun'] as const) {
  describe(`${target} retained container probe`, () => {
    it('refuses without the current Anthropic key even when retired provider rows describe an endpoint', async () => {
      const r = rig(target);
      try {
        r.legacy('agent.provider.type', 'openai-compatible');
        r.legacy('agent.provider.model', 'old-model');
        r.legacy('agent.provider.base_url', 'http://models.example/v1');
        expect(await prepareDispatch(r.env, 'container-smoke', 'proj_1')).toEqual({ ok: false, refusal: 'probe_preferences_invalid' });
        expect(r.launches).toEqual([]);
      } finally { r.sqlite.close(); }
    });

    it('launches with Anthropic and the current Claude default-tier model, ignoring retired fields', async () => {
      const r = rig(target);
      try {
        await r.key.put('anthropic', TEST_KEY, 'test', 1);
        const builtIn = PROFILE_HARNESSES['claude-code']!.models.default;
        const before = await prepareDispatch(r.env, 'container-smoke', 'proj_1');
        expect(before).toMatchObject({ ok: true, prepared: { providerType: 'anthropic', model: builtIn, provider: { type: 'anthropic', model: builtIn } } });
        expect((before as { prepared: { provider: Record<string, unknown> } }).prepared.provider).not.toHaveProperty('baseUrl');
        expect(r.sqlite.query("SELECT COUNT(*) AS n FROM deployment_settings WHERE leaf LIKE 'agent.provider.%'").get()).toEqual({ n: 0 });

        r.legacy('agent.provider.type', 'openai-compatible');
        r.legacy('agent.provider.model', 'old-model');
        r.legacy('agent.provider.base_url', 'http://models.example/v1');
        r.legacy('agent.tasks', { 'container-smoke': { provider: 'openai-compatible', model: 'old-task-model' } });

        expect(await settingsWriter(r.env.db).setLeaf(MODEL_LEAF, 'opus', 'test', 2)).toEqual({ applied: true });
        const changed = await dispatchTask(r.env, 'container-smoke', 'proj_1', { serverUrl: 'https://s', actor: 'test', timeoutSeconds: 120 }, 3);
        expect(changed).toMatchObject({ dispatched: true, provider: 'anthropic' });
        expect(r.launches).toHaveLength(1);
        expect(r.launches[0]!.envVars.MYCO_MODEL).toBe('opus');
        expect(JSON.parse(r.launches[0]!.envVars.MYCO_PROVIDER_JSON!)).toEqual({ type: 'anthropic', model: 'opus' });

        r.legacy(MODEL_LEAF, 'not a claude model');
        expect(await prepareDispatch(r.env, 'container-smoke', 'proj_1')).toEqual({ ok: false, refusal: 'probe_preferences_invalid' });
        expect(r.launches).toHaveLength(1);
      } finally { r.sqlite.close(); }
    });
  });
}
