import { D1_REWIND_RETENTION_MS } from '@myco-server-worker/constants.js';
import { rewindAvailability } from '@myco-server-worker/core/rewind.js';

/** Validate an operator's instant without contacting or changing a Deployment. */
export function refuseRewind(options: { target: 'local' | 'cloudflare'; to?: string; now?: number }): never {
  const next = 'myco server rewind --target cloudflare --to <ISO-8601-time-with-zone-or-Unix-seconds>';
  if (options.target === 'local') throw new Error(`Rewind refused; nothing changed. ${rewindAvailability('bun')} Use --from <verified-artifact> --source-retired --yes in a fresh MYCO_HOME.`);
  const { to } = options;
  const now = options.now ?? Date.now();
  const timestamp = to !== undefined && /^\d{10}$/.test(to) ? Number(to) * 1000
    : to !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(to) ? Date.parse(to) : NaN;
  if (!Number.isFinite(timestamp) || (to?.includes('T') && new Date(Date.parse(to.slice(0, 19) + 'Z')).toISOString().slice(0, 19) !== to.slice(0, 19))) throw new Error(`Rewind refused; nothing changed. --to is ${JSON.stringify(to ?? '(missing)')}; use ISO 8601 with an explicit zone or 10-digit Unix seconds. Next: ${next}`);
  if (timestamp > now) throw new Error(`Rewind refused; nothing changed. --to ${to} is after now (${new Date(now).toISOString()}). Next: ${next}`);
  if (timestamp < now - D1_REWIND_RETENTION_MS) throw new Error(`Rewind refused; nothing changed. --to ${to} is before ${new Date(now - D1_REWIND_RETENTION_MS).toISOString()}, the maximum 30-day window (Free: 7 days). Next: myco server restore --target cloudflare --from <verified-artifact> --source-retired --yes in a fresh MYCO_HOME.`);
  throw new Error(`Rewind to ${new Date(timestamp).toISOString()} refused; nothing changed. ${rewindAvailability('cloudflare')} Use --from <verified-artifact> --source-retired --yes in a fresh MYCO_HOME. No database-only restore was issued.`);
}
