import { Glob } from 'bun';
import { afterAll, beforeAll, describe, it, test } from 'bun:test';
import { runScenario, scenarioCoversTarget, type ParityScenario, type ParityTarget } from './harness.ts';
import { bootSelfhosted } from './targets/selfhosted.ts';
import { bootCloudflare, stopCloudflareRuntime } from './targets/cloudflare.ts';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { PARITY_PLAN_PREFIX, parseShard, selectShard } from '../../scripts/test-shards.mjs';
import { PARITY_SMOKE_SCENARIOS } from '../../scripts/ci-scopes.mjs';
import durations from '../../scripts/test-durations.json';

const DEFAULT_SCENARIO_DURATION_MS = 15_000;

function isScenario(value: unknown): value is ParityScenario {
  return typeof value === 'object' && value !== null && typeof (value as ParityScenario).name === 'string'
    && typeof (value as ParityScenario).run === 'function';
}

/** Every scenario any file under `scenarios/` exports: files in path order, and within a file by export name. */
const scenarios: ParityScenario[] = [];
for (const file of [...new Glob('scenarios/*.ts').scanSync({ cwd: import.meta.dir })].sort()) {
  const module: Record<string, unknown> = await import(`./${file}`);
  for (const value of Object.values(module)) {
    if (isScenario(value) && !scenarios.includes(value)) scenarios.push(value);
  }
}
const repeatedNames = scenarios.map((scenario) => scenario.name).filter((name, index, names) => names.indexOf(name) !== index);
if (repeatedNames.length > 0) {
  throw new Error(`Parity scenarios share a name, and weights, shards and the smoke list are keyed by name: ${repeatedNames.join('; ')}. Give each scenario a name of its own.`);
}

if (!process.env.MYCO_PARITY) {
  test.skip('parity scenarios (run via npm run test:parity)', () => {});
} else {
  const weights: Record<string, number> = durations.parity;
  const plan = (shard: string | undefined) => selectShard(scenarios, parseShard(shard), (scenario) => weights[scenario.name] ?? DEFAULT_SCENARIO_DURATION_MS);
  const smoke = scenarios.filter((scenario) => PARITY_SMOKE_SCENARIOS.includes(scenario.name));
  if (smoke.length !== PARITY_SMOKE_SCENARIOS.length) throw new Error(`Parity smoke names ${PARITY_SMOKE_SCENARIOS.length} scenarios but ${smoke.length} exist`);
  const only = process.env.MYCO_PARITY_ONLY?.split(',').filter(Boolean), selected = (process.env.MYCO_PARITY_SCOPE === 'smoke' ? smoke : plan(process.env.MYCO_PARITY_SHARD)).filter((scenario) => only === undefined || only.some((part) => scenario.name.includes(part)));
  if (process.env.MYCO_PARITY_PLAN === '1') {
    const selectors: string[] | undefined = process.env.MYCO_PARITY_PLAN_MATRIX === undefined ? undefined : JSON.parse(process.env.MYCO_PARITY_PLAN_MATRIX);
    if (selectors !== undefined && (!Array.isArray(selectors) || !selectors.every(value => typeof value === 'string'))) throw new Error('Invalid parity matrix selectors');
    const names = (shard: string | undefined) => plan(shard).map(scenario => scenario.name);
    console.log(PARITY_PLAN_PREFIX + JSON.stringify(selectors === undefined ? selected.map(scenario => scenario.name) : {
      full: names(undefined), shards: selectors.map(shard => ({ shard, scenarios: names(shard) })),
    }));
    test.skip('parity shard manifest', () => {});
  } else {
    // A self-hosted scenario that queries vectors loads sqlite-vec, which needs an extension-enabled SQLite registered
    // before the first connection in this process opens; a no-op wherever the runtime's own library already loads
    // extensions. A host that has none fails only the scenarios that need one, and says why.
    let sqliteVecRefusal: string | null = null;
    afterAll(stopCloudflareRuntime);
    try { configureSqliteLibrary(); } catch (error) { sqliteVecRefusal = error instanceof Error ? error.message : String(error); }
    const boots = [
      { name: 'selfhosted' as const, boot: (scenario?: ParityScenario) => bootSelfhosted({ stopRace: scenario?.dedicated?.stopRace === true, embeddingFixture:scenario?.dedicated?.cloudflare?.embeddingFixture===true, latestSchemaUpgrade: scenario?.dedicated?.latestSchemaUpgrade === true }) },
      { name: 'cloudflare' as const, boot: (scenario?: ParityScenario) => bootCloudflare({ ...scenario?.dedicated?.cloudflare, latestSchemaUpgrade: scenario?.dedicated?.latestSchemaUpgrade === true }) },
    ];
    const shared = selected.filter((scenario) => scenario.dedicated === undefined);
    const dedicated = selected.filter((scenario) => scenario.dedicated !== undefined);
    for (const { name, boot } of boots.filter((entry) => process.env.MYCO_PARITY_TARGET === undefined || entry.name === process.env.MYCO_PARITY_TARGET)) {
      const targetShared = shared.filter((scenario) => scenarioCoversTarget(scenario, name));
      const targetDedicated = dedicated.filter((scenario) => scenarioCoversTarget(scenario, name));
      if (targetShared.length > 0) {
        describe(`[${name}]`, () => {
          let target: ParityTarget | null = null;
          beforeAll(async () => {
            target = await boot();
          }, 240_000);
          afterAll(async () => {
            await target?.stop();
          });
          for (const scenario of targetShared) {
            it(scenario.name, async () => {
              if (target === null) throw new Error(`${name} target never booted`);
              await runScenario(target, scenario);
            }, 180_000);
          }
        });
      }
      // Each dedicated scenario boots its own target, so whatever it binds or configures reaches no other scenario.
      for (const scenario of targetDedicated) {
        describe(`[${name}] ${scenario.name}`, () => {
          let target: ParityTarget | null = null;
          let peer: ParityTarget | null = null;
          beforeAll(async () => {
            target = await boot(scenario);
            if (scenario.paired === true) peer = await boot(scenario);
          }, scenario.paired === true ? 360_000 : 240_000);
          afterAll(async () => {
            try { await peer?.stop(); }
            finally { await target?.stop(); }
          });
          it(scenario.name, async () => {
            if (name === 'selfhosted' && scenario.dedicated!.sqliteVec === true && sqliteVecRefusal !== null) {
              throw new Error(`this scenario needs sqlite-vec on the self-hosted target, which this host cannot load: ${sqliteVecRefusal}`);
            }
            if (target === null) throw new Error(`${name} target never booted`);
            await runScenario(target, scenario, peer ?? undefined);
          }, scenario.dedicated!.timeoutMs);
        });
      }
    }
  }
}
