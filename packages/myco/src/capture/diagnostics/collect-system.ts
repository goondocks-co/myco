import os from 'node:os';
import { runChecks } from '../../cli/doctor.js';
import { runAudit } from '../audit/index.js';

const SECRET_KEY = /(key|token|secret|password|credential|bearer)/i;

/** Belt-and-suspenders: secrets live in secrets.env, never myco.yaml — but filter anyway. */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactConfig(v);
  }
  return out;
}

export function collectEnvironment(opts: {
  config: unknown;
  mycoVersion: string;
  schemaVersion: number;
}): string {
  return JSON.stringify(
    {
      myco_version: opts.mycoVersion,
      schema_version: opts.schemaVersion,
      platform: `${os.platform()}-${os.arch()}`,
      os_release: os.release(),
      node_version: process.version,
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      config: redactConfig(opts.config),
    },
    null,
    2,
  );
}

export async function collectDoctor(vaultDir: string): Promise<string> {
  return JSON.stringify(await runChecks(vaultDir), null, 2);
}

export function collectAudit(opts: { dbPath: string; since: number }): string {
  // First real consumer of runAudit (audit/index.ts:51) — read-only by
  // construction (openReadonly). Budget for latent issues here.
  return JSON.stringify(runAudit({ dbPath: opts.dbPath, since: opts.since }), null, 2);
}
