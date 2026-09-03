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

const DATABASE_ID_PLACEHOLDER = '<YOUR_D1_DATABASE_ID>';
const DOCKERFILE_IMAGE_LINE = 'image = "./harness/Dockerfile"';
const FLEET_LINE_RE = /^max_instances = \d+$/m;
const HARNESS_IMAGE_RE = /^registry\.cloudflare\.com\/[0-9a-f]{32}\/[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;

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

  let body = WRANGLER_TEMPLATE.replace(DATABASE_ID_PLACEHOLDER, record.databaseId!);
  if (record.harnessImage !== undefined && record.harnessImage !== '') {
    if (!HARNESS_IMAGE_RE.test(record.harnessImage)) {
      throw new Error(`the deployment record's harnessImage is not a digest-pinned registry URI: ${JSON.stringify(record.harnessImage)} (~/.myco/server/cloudflare/record.json)`);
    }
    if (!body.includes(DOCKERFILE_IMAGE_LINE)) {
      throw new Error('the template carries no Dockerfile image line to pin; renderDeployConfig and wrangler.toml have drifted');
    }
    body = body.replace(DOCKERFILE_IMAGE_LINE, `image = "${record.harnessImage}"`);
  }
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
  if (record.fleet !== undefined) {
    if (!Number.isInteger(record.fleet) || record.fleet < 1) {
      throw new Error(`the deployment record's fleet is not a whole number of runtimes: ${JSON.stringify(record.fleet)} (~/.myco/server/cloudflare/record.json)`);
    }
    if (!FLEET_LINE_RE.test(body)) throw new Error('the template carries no max_instances line to set; renderDeployConfig and wrangler.toml have drifted');
    body = body.replace(FLEET_LINE_RE, `max_instances = ${record.fleet}`);
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
 * ui/dist, and every parity route is worker-owned), and the container tables
 * dropped (a local container needs Docker; the probe surface answers a
 * refusal where the binding is absent). A multi-line flags array or a second
 * flag fails loudly rather than shipping a silently different runtime.
 */
const PARITY_DROPPED_HEADERS = ['[assets]', '[[containers]]'];

/**
 * Whether a table is dropped for parity: the assets and the container, and the
 * Durable Object that fronts the container with its migration — a local
 * container needs Docker. The clock is a Durable Object too, needs nothing,
 * and rides into parity so the wake is proven on this target as on the other.
 */
function parityDrops(header: string, block: readonly string[]): boolean {
  if (PARITY_DROPPED_HEADERS.includes(header)) return true;
  if (header === '[[durable_objects.bindings]]' || header === '[[migrations]]') return block.some((line) => line.includes('"HarnessContainer"'));
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
