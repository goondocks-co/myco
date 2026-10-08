/**
 * Which paths the server owns and which the dashboard serves, on both targets.
 *
 * Cloudflare decides it at the edge from `run_worker_first` in `wrangler.toml`; self-hosted decides it in
 * `platform/bun/static.ts` from `isOwnedPath`. Both read the same patterns (`ownedPathPatterns()`, held equal to the
 * toml by `gates.test.ts`), and this holds that they read them the same way: the edge's own router, run here in
 * Miniflare against the committed `[assets]` table, and the self-hosted wrapper agree on every probe. `/x/*` owns the
 * paths under `/x/` and never `/x`, so a dashboard page may sit at `/sessions` while the server keeps `/sessions/…`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { RETIRED_ROUTES, ROUTES, isOwnedPath, ownedPathPatterns } from '@myco-server-worker/routes.js';
import { withStaticAssets, withStaticMap } from '@myco-server-worker/platform/bun/static.js';

const WRANGLER = readFileSync(join(import.meta.dir, '..', '..', 'packages', 'myco-server', 'wrangler.toml'), 'utf8');
const tomlValue = (key: string): string => {
  const line = new RegExp(`^${key} = (.+)$`, 'm').exec(WRANGLER)?.[1];
  expect({ key, found: line !== undefined }).toEqual({ key, found: true });
  return line!;
};
const RUN_WORKER_FIRST = [...tomlValue('run_worker_first').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
const SHELL = '<!doctype html><div id="root"></div>';
const SERVER = 'server';

/** The dashboard's pages in the plan's URL scheme, each at its bare path. */
const PAGES = ['/', '/sessions', '/knowledge', '/knowledge/plans', '/work', '/projects', '/people', '/settings', '/status', '/me/machines', '/join', '/link', '/device', '/spores', '/plans', '/p/proj_1/sessions'];
/** Every route path, live and retired, with its parameters filled in. */
const ROUTE_PATHS = [...ROUTES, ...RETIRED_ROUTES].map((r) => r.path.replace(/\{[^}]+\}/g, 'x'));
/** The bare path of every `/x/*` pattern that no route serves exactly: what the pattern must not own. */
const BARE_PREFIXES = ownedPathPatterns().filter((p) => p.endsWith('/*')).map((p) => p.slice(0, -2)).filter((p) => !ownedPathPatterns().includes(p));
/** Every exact pattern, which owns its path and nothing under it. */
const EXACT = ownedPathPatterns().filter((p) => !p.endsWith('/*'));
const PROBES = [...new Set([...PAGES, ...ROUTE_PATHS, ...BARE_PREFIXES, ...[...BARE_PREFIXES, ...EXACT].map((p) => `${p}/`)])].sort();

let dir = '';
let mf: Miniflare | null = null;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myco-owned-paths-'));
  writeFileSync(join(dir, 'index.html'), SHELL);
  mf = new Miniflare({
    modules: true,
    script: `export default { fetch: () => new Response(${JSON.stringify(SERVER)}, { status: 401 }) }`,
    compatibilityDate: JSON.parse(tomlValue('compatibility_date')) as string,
    assets: {
      directory: dir,
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false, static_routing: { user_worker: RUN_WORKER_FIRST } },
      assetConfig: { not_found_handling: JSON.parse(tomlValue('not_found_handling')) as 'single-page-application', has_static_routing: true },
    },
  });
  await mf.ready;
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** Who answers `path` at the edge: the Worker or the dashboard. */
async function edge(path: string): Promise<'server' | 'dashboard'> {
  const res = await mf!.dispatchFetch(`http://localhost${path}`);
  const body = await res.text();
  if (body === SERVER) return 'server';
  expect({ path, body }).toEqual({ path, body: SHELL });
  return 'dashboard';
}

/** Who answers `path` self-hosted, through both static wrappers, which must agree. */
async function selfhosted(path: string, method = 'GET'): Promise<'server' | 'dashboard'> {
  const next = async () => new Response(SERVER, { status: 401 });
  const answers = await Promise.all([
    withStaticAssets(dir, next)(new Request(`https://s${path}`, { method })),
    withStaticMap({ 'index.html': new TextEncoder().encode(SHELL) }, next)(new Request(`https://s${path}`, { method })),
  ].map(async (pending) => ((await (await pending).text()) === SERVER ? 'server' as const : 'dashboard' as const)));
  expect({ path, agree: answers[0] === answers[1] }).toEqual({ path, agree: true });
  return answers[0]!;
}

describe('the paths the server owns, read the same way on both targets', () => {
  it('serves the Sessions page at /sessions on both targets, while the server keeps /sessions/register', async () => {
    expect(await edge('/sessions')).toBe('dashboard');
    expect(await selfhosted('/sessions')).toBe('dashboard');
    expect(await edge('/sessions/register')).toBe('server');
    expect(await selfhosted('/sessions/register', 'POST')).toBe('server');
  });

  it('agrees with the edge on every page, every route, and the bare path of every prefix the server owns', async () => {
    const differ: string[] = [];
    for (const path of PROBES) {
      const [cloudflare, bun] = [await edge(path), await selfhosted(path)];
      if (cloudflare !== bun) differ.push(`${path}: edge ${cloudflare}, self-hosted ${bun}`);
      expect({ path, owned: isOwnedPath(path) }).toEqual({ path, owned: bun === 'server' });
    }
    expect(differ).toEqual([]);
  });

  it('owns every route it serves, and of the dashboard\'s pages only /health, which is the server\'s own', async () => {
    for (const path of ROUTE_PATHS) expect({ path, owner: await selfhosted(path) }).toEqual({ path, owner: 'server' });
    for (const prefix of BARE_PREFIXES) expect({ prefix, owner: await selfhosted(prefix) }).toEqual({ prefix, owner: 'dashboard' });
    const owned: string[] = [];
    for (const page of [...PAGES, '/health']) if (await selfhosted(page) === 'server') owned.push(page);
    expect(owned).toEqual(['/health']);
  });
});
