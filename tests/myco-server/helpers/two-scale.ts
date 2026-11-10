import { expect } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { measuredStore } from './read-budget.js';
import { schemaD1Root } from './schema-template.js';

/**
 * The statistics the store plans from: none, as D1 does; `analyzed`, taken of the corpus as it stands at each size; or
 * `stale`, taken at the small size only, as a store last analyzed while small plans once it has grown.
 */
export type Statistics = 'none' | 'analyzed' | 'stale';

/** Where a case runs: 0 the small size, 1 the large, -1 the unmeasured warm-up; the store unmeasured for fixture writes; a restart of the measurement. */
export interface CostRun { scale: -1 | 0 | 1; store: RelationalStore; restart: () => void }

export interface CostCase {
  name: string;
  /** One request at one size, on the measured store. Cases run in order at each size. */
  run: (db: RelationalStore, at: CostRun) => Promise<unknown>;
  /** Rows the request may read at the large size beyond the small one. Writes get no extra. */
  extra?: number;
}

export interface CaseCost { name: string; statistics: Statistics; reads: [number, number]; writes: [number, number]; extra: number }

/**
 * Measures each case on a D1 store at a small and a large corpus, once for each of `statistics` (by default no planner
 * statistics, then a store analyzed after every growth). `grow` adds the corpus units [from, to); `setup` runs once on each empty store.
 * With `warm`, every case runs once unmeasured at the small size before it is measured there, so both sizes measure a
 * request that is not the first of its kind.
 */
export async function d1TwoScale(options: {
  sizes: readonly [number, number];
  setup?: (db: RelationalStore) => Promise<void>;
  grow: (db: RelationalStore, from: number, to: number) => Promise<void>;
  cases: readonly CostCase[];
  statistics?: readonly Statistics[];
  warm?: boolean;
}): Promise<CaseCost[]> {
  const costs: CaseCost[] = [];
  for (const statistics of options.statistics ?? ['none', 'analyzed'] as const) {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
    try {
      const store = await mf.getD1Database('DB') as unknown as RelationalStore;
      await options.setup?.(store);
      const measured = measuredStore(store as never);
      const rows = options.cases.map(() => ({ reads: [0, 0] as [number, number], writes: [0, 0] as [number, number] }));
      let grown = 0;
      for (const scale of [0, 1] as const) {
        await options.grow(store, grown, options.sizes[scale]);
        grown = options.sizes[scale];
        if (statistics === 'analyzed' || (statistics === 'stale' && scale === 0)) await store.prepare('ANALYZE').run();
        if (scale === 0 && options.warm === true) for (const item of options.cases) await item.run(store, { scale: -1, store, restart: () => {} });
        for (const [index, item] of options.cases.entries()) {
          measured.reset();
          await item.run(measured.db, { scale, store, restart: measured.reset });
          rows[index]!.reads[scale] = measured.reads();
          rows[index]!.writes[scale] = measured.writes();
        }
      }
      for (const [index, item] of options.cases.entries()) costs.push({ name: item.name, statistics, ...rows[index]!, extra: item.extra ?? 0 });
    } finally { await mf.dispose(); }
  }
  console.info('TWO_SCALE_COST ' + JSON.stringify({ sizes: options.sizes, costs }));
  return costs;
}

/** Each request read at the large size no more rows than at the small one plus its allowed extra, and wrote no more. */
export function expectTwoScale(costs: readonly CaseCost[]): void {
  for (const cost of costs) {
    const label = `${cost.name} (statistics: ${cost.statistics})`;
    expect(cost.reads[0] + cost.writes[0], `${label} touched no rows, so it measured nothing`).toBeGreaterThan(0);
    expect(cost.reads[1], `${label} rows read, small ${cost.reads[0]}`).toBeLessThanOrEqual(cost.reads[0] + cost.extra);
    expect(cost.writes[1], `${label} rows written, small ${cost.writes[0]}`).toBeLessThanOrEqual(cost.writes[0]);
  }
}

/**
 * A request reported for walking rows it should seek (`issue` names the report, #2174 for the first four). It still
 * reads more at the large size than its extra allows, and at most `perUnit` rows for each of the `units` the corpus grew
 * by; it writes no more. The lower bound fails once the read is keyed, so the exemption is removed with the fix; the
 * upper bound fails if the walk gets worse.
 */
export function expectReportedWalk(cost: CaseCost, walk: { issue: string; perUnit: number; units: number }): void {
  const label = `${walk.issue} ${cost.name} (statistics: ${cost.statistics})`;
  const [small, large] = cost.reads;
  expect(large, `${label}: the walk is gone, so remove this exemption; rows read, small ${small}`).toBeGreaterThan(small + cost.extra);
  expect(large, `${label}: the walk grew past ${walk.perUnit} rows per unit; rows read, small ${small}`)
    .toBeLessThanOrEqual(small + walk.perUnit * walk.units + cost.extra);
  expect(cost.writes[1], `${label} rows written, small ${cost.writes[0]}`).toBeLessThanOrEqual(cost.writes[0]);
}

/** Runs `insert` once for each corpus unit in [from, to), the unit's number as `n.i`; `binds` are `?3` onward. */
export async function eachUnit(db: RelationalStore, from: number, to: number, insert: string, ...binds: unknown[]): Promise<void> {
  if (from >= to) return;
  await db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(?1 AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?2) ${insert}`)
    .bind(from, to, ...binds).run();
}
