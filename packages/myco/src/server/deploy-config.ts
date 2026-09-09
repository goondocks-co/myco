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
 * Every configuration table a rendered deploy config may declare.
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
  '[[secrets_store_secrets]]',
  '[ai]',
  '[[vectorize]]',
  '[vars]',
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
 * The class-lifecycle ledger a configuration declares, in order: each entry's
 * tag, the classes it brings into existence, and the classes it ends.
 *
 * A rename is both: the new name comes into existence and the old one ceases,
 * so a class renamed and later deleted under its new name is a complete and
 * legitimate history. Reading only creates and deletes would call that a delete
 * of something never created.
 */
export function migrationLedger(config: string): Array<{ tag: string; creates: string[]; deletes: string[] }> {
  const entries: Array<{ tag: string; creates: string[]; deletes: string[] }> = [];
  // A rename may be written as a sub-table under the entry it belongs to, whose
  // `from` and `to` arrive on their own lines after the header.
  let scope: 'none' | 'entry' | 'rename' = 'none';
  let pending: { from?: string; to?: string } = {};
  const closeRename = (): void => {
    const entry = entries[entries.length - 1];
    if (entry !== undefined && pending.to !== undefined) entry.creates.push(pending.to);
    if (entry !== undefined && pending.from !== undefined) entry.deletes.push(pending.from);
    pending = {};
  };
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      if (scope === 'rename') closeRename();
      if (line === '[[migrations]]') { entries.push({ tag: '', creates: [], deletes: [] }); scope = 'entry'; }
      else if (line === '[[migrations.renamed_classes]]' && entries.length > 0) scope = 'rename';
      else scope = 'none';
      continue;
    }
    if (scope === 'none' || entries.length === 0) continue;
    const entry = entries[entries.length - 1]!;
    if (scope === 'rename') {
      const from = /^from = "([^"]+)"$/.exec(line);
      const to = /^to = "([^"]+)"$/.exec(line);
      if (from) pending.from = from[1]!;
      if (to) pending.to = to[1]!;
      continue;
    }
    const tag = /^tag = "([^"]+)"$/.exec(line);
    if (tag) { entry.tag = tag[1]!; continue; }
    const names = (key: string): string[] =>
      [...(new RegExp(`^${key} = \\[([^\\]]*)\\]$`).exec(line)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    entry.creates.push(...names('new_sqlite_classes'), ...names('new_classes'));
    entry.deletes.push(...names('deleted_classes'));
    // The inline form of the same rename: `renamed_classes = [{ from = "A", to = "B" }]`.
    for (const pair of (/^renamed_classes = \[(.*)\]$/.exec(line)?.[1] ?? '').matchAll(/\{[^}]*\}/g)) {
      const from = /from = "([^"]+)"/.exec(pair[0])?.[1];
      const to = /to = "([^"]+)"/.exec(pair[0])?.[1];
      if (to !== undefined) entry.creates.push(to);
      if (from !== undefined) entry.deletes.push(from);
    }
  }
  if (scope === 'rename') closeRename();
  return entries;
}

/**
 * Every class a configuration deletes that is not live when the delete runs.
 *
 * The ledger is applied in order from the instance's own recorded tag, so a
 * delete naming a class the history never created is refused and the instance
 * never starts — on a fresh local boot and on a Deployment created after the
 * class was retired alike. Retiring a class means appending a delete, never
 * removing the entry that created it. A rename carries the class forward under
 * its new name, so deleting the new name later is legitimate and deleting the
 * old one after the rename is not.
 */
export function undeletableClasses(config: string): string[] {
  const live = new Set<string>();
  const orphans: string[] = [];
  for (const entry of migrationLedger(config)) {
    // Liveness, not history: an entry ends a class as well as beginning one, so
    // a name deleted twice, or deleted after a rename carried it away, is as
    // absent as one never created.
    for (const name of entry.deletes) { if (!live.has(name)) orphans.push(name); live.delete(name); }
    for (const name of entry.creates) live.add(name);
  }
  return orphans;
}

/**
 * The committed configuration shaped for a local parity/dev boot:
 * `global_fetch_strictly_public` dropped (a scenario's loopback provider stub
 * must be reachable), the `[assets]` table dropped (a fresh worktree holds no
 * ui/dist, and every parity route is worker-owned). A multi-line flags array or
 * a second flag fails loudly rather than shipping a silently different runtime.
 */
const PARITY_DROPPED_HEADERS = ['[assets]'];

/**
 * Whether a table is dropped for parity: the assets, and nothing else. The
 * class-lifecycle ledger rides into parity whole, so a local boot applies the
 * same migrations a deploy does and refuses the same ones.
 */
function parityDrops(header: string): boolean {
  return PARITY_DROPPED_HEADERS.includes(header);
}

export function parityWranglerConfig(): string {
  const kept: string[] = [];
  let header: string | null = null;
  let block: string[] = [];
  const flush = (): void => {
    if (header === null || !parityDrops(header)) kept.push(...block);
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
