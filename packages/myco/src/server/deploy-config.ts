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

/** Raised when the record cannot feed the renderer; names every missing fact. */
export class DeployConfigIncomplete extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `the deployment record is missing ${missing.join(', ')}. `
      + 'Add the field(s) to ~/.myco/server/cloudflare.json (databaseId: the D1 UUID from '
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
    throw new Error(`the deployment record's url is not a URL: ${JSON.stringify(url)} (~/.myco/server/cloudflare.json)`);
  }
  if (parsed.port !== '') {
    throw new Error(`the deployment record's url carries a port (${parsed.host}); a Cloudflare custom domain has none (~/.myco/server/cloudflare.json)`);
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
  return `${header.join('\n')}\n${body}`;
}

/**
 * The committed configuration shaped for a local parity/dev boot:
 * `global_fetch_strictly_public` dropped (a scenario's loopback provider stub
 * must be reachable) and the `[assets]` table dropped (a fresh worktree holds
 * no ui/dist, and every parity route is worker-owned). A multi-line flags
 * array or a second flag fails loudly rather than shipping a silently
 * different runtime.
 */
export function parityWranglerConfig(): string {
  const kept: string[] = [];
  let inAssets = false;
  for (const line of WRANGLER_TEMPLATE.split('\n')) {
    if (line.startsWith('compatibility_flags')) {
      if (!line.includes(']')) throw new Error('compatibility_flags spans lines; teach parityWranglerConfig before reformatting wrangler.toml');
      const stripped = line.replace(/"global_fetch_strictly_public"\s*,?\s*/, '');
      if (/"/.test(stripped.split('=')[1] ?? '')) kept.push(stripped);
      continue;
    }
    if (line.trim() === '[assets]') { inAssets = true; continue; }
    if (inAssets && /^\[/.test(line.trim())) inAssets = false;
    if (!inAssets) kept.push(line);
  }
  return kept.join('\n');
}
