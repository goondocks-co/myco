/**
 * The deploy configuration, derived — never hand-edited.
 *
 * `wrangler.deploy.toml` is the committed configuration plus exactly three
 * facts the repository must not hold: the account, the routes, and the
 * per-account resource ids. All three live in the deployment record, so the
 * config is reproducible from the record and the committed base — a binding
 * added to the committed file reaches production on the next render instead of
 * waiting for someone to notice a hand-maintained copy drifted.
 */
import type { DeploymentRecord } from './cloudflare.js';
import { WRANGLER_TEMPLATE } from './wrangler-template.js';
import { VECTOR_BINDINGS } from './vector-config.js';

/**
 * Every configuration table the committed Worker configuration declares.
 *
 * Each is a surface the free plan serves. Containers are a paid surface, and a
 * table added without a decision moves every operator onto a plan they did not
 * choose, so a new one has to be named here before it can ship.
 */
export const FREE_TIER_SURFACES = [
  '[observability]',
  '[observability.logs]',
  '[[d1_databases]]',
  '[[r2_buckets]]',
  '[[ratelimits]]',
  '[assets]',
  '[triggers]',
  '[[durable_objects.bindings]]',
  '[[migrations]]',
] as const;

const DATABASE_ID_PLACEHOLDER = '<YOUR_D1_DATABASE_ID>';
const SOURCE_ENTRY_LINE = 'main = "src/index.ts"';

/**
 * What a staged deploy runs and how wrangler must treat it: the carried bundle
 * is already built, and the staging directory beside it holds the dashboard and
 * the migrations. `no_bundle` turns `find_additional_modules` on by default,
 * which sweeps every file under the entry's directory into the Worker script,
 * so the entry sits alone in its own directory AND the sweep is turned off.
 */
const STAGED_ENTRY_LINES = [
  'main = "worker/worker.js"',
  'no_bundle = true',
  'find_additional_modules = false',
].join('\n');

/** Raised when the record cannot feed the renderer; names every missing fact. */
export class DeployConfigIncomplete extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `the deployment record is missing ${missing.join(', ')}. `
      + 'Add the field(s) to ~/.myco/server/cloudflare/record.json (databaseId: the D1 UUID from '
      + '`wrangler d1 list`; storeId: from `wrangler secrets-store store list --remote`).',
    );
    this.name = 'DeployConfigIncomplete';
  }
}

/** The routes block for a record whose URL is a custom domain; a workers.dev URL needs none. */
function routesLine(url: string | undefined): string | null {
  if (url === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`the deployment record's url is not a URL: ${JSON.stringify(url)} (~/.myco/server/cloudflare/record.json)`);
  }
  if (parsed.port !== '') {
    throw new Error(`the deployment record's url carries a port (${parsed.host}); a Cloudflare custom domain has none (~/.myco/server/cloudflare/record.json)`);
  }
  if (parsed.hostname.endsWith('.workers.dev')) return null;
  return `routes = [ { pattern = "${parsed.hostname}", custom_domain = true } ]`;
}

/** The deploy config for this record: the committed base with the record's account, routes, database id, and secrets store. */
export function renderDeployConfig(record: DeploymentRecord): string {
  const missing: string[] = [];
  if (record.databaseId === undefined || record.databaseId === '') missing.push('databaseId');
  if (missing.length > 0) throw new DeployConfigIncomplete(missing);

  const header = [`account_id = "${record.accountId}"`];
  const routes = routesLine(record.url);
  if (routes !== null) header.push(routes);

  if (!WRANGLER_TEMPLATE.includes(SOURCE_ENTRY_LINE)) {
    throw new Error('the template carries no source entry line to replace; renderDeployConfig and wrangler.toml have drifted');
  }
  let body = WRANGLER_TEMPLATE
    .replace(SOURCE_ENTRY_LINE, STAGED_ENTRY_LINES)
    .replace(DATABASE_ID_PLACEHOLDER, record.databaseId!) + VECTOR_BINDINGS;
  if (record.storeId !== undefined && record.storeId !== '') {
    body += [
      '',
      '[[secrets_store_secrets]]',
      'binding = "SECRET_WRAP_KEY"',
      `store_id = "${record.storeId}"`,
      'secret_name = "myco-secret-wrap-key"',
      '',
    ].join('\n');
  }
  if (record.fleet !== undefined && (!Number.isInteger(record.fleet) || record.fleet < 1)) {
    throw new Error(`the deployment record's fleet is not a whole number of runtimes: ${JSON.stringify(record.fleet)} (~/.myco/server/cloudflare/record.json)`);
  }
  // What the Worker is told about itself: the origin the clock's runs call back to, and the fleet the dispatcher counts against. Both are the record's, never a request's.
  const vars: string[] = [];
  if (record.url !== undefined) vars.push(`MYCO_ORIGIN = "${new URL(record.url).origin}"`);
  if (record.fleet !== undefined) vars.push(`MYCO_FLEET = "${record.fleet}"`);
  if (vars.length > 0) body += ['', '[vars]', ...vars, ''].join('\n');
  return `${header.join('\n')}\n${body}`;
}

/**
 * The committed configuration shaped for a local parity/dev boot:
 * `global_fetch_strictly_public` dropped (a scenario's loopback provider stub
 * must be reachable), the `[assets]` table dropped (a fresh worktree holds no
 * ui/dist, and every parity route is worker-owned), and the retired class's
 * migration dropped. A multi-line flags array or a second flag fails loudly
 * rather than shipping a silently different runtime.
 */
const PARITY_DROPPED_HEADERS = ['[assets]'];

/**
 * Whether a table is dropped for parity: the assets, and any class-lifecycle
 * migration naming a class this Worker no longer exports — a local boot
 * resolves every named class against the code it is running. The clock is
 * exported and rides into parity so the wake is proven on this target as on
 * the other.
 */
function parityDrops(header: string, block: readonly string[]): boolean {
  if (PARITY_DROPPED_HEADERS.includes(header)) return true;
  if (header === '[[migrations]]') return block.some((line) => line.includes('"HarnessContainer"'));
  return false;
}

export function parityWranglerConfig(): string {
  const kept: string[] = [];
  let header: string | null = null;
  let block: string[] = [];
  const flush = (): void => {
    if (header === null || !parityDrops(header, block)) kept.push(...block);
    block = [];
  };
  for (const line of WRANGLER_TEMPLATE.split('\n')) {
    if (line.startsWith('compatibility_flags')) {
      if (!line.includes(']')) throw new Error('compatibility_flags spans lines; teach parityWranglerConfig before reformatting wrangler.toml');
      const stripped = line.replace(/"global_fetch_strictly_public"\s*,?\s*/, '');
      if (/"/.test(stripped.split('=')[1] ?? '')) block.push(stripped);
      continue;
    }
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) { flush(); header = trimmed; }
    block.push(line);
  }
  flush();
  return kept.join('\n');
}
