import { lit, type ParityTarget } from '../harness.ts';

/** Stored security witness: ciphertext transplanted across tenants must fail to open under the destination key. */
export async function transplantSecret(target: ParityTarget, row: Record<string, unknown>): Promise<void> {
  await target.sql(`UPDATE deployment_secrets SET ciphertext = ${lit(String(row.ciphertext))}, iv = ${lit(String(row.iv))}, key_version = ${Number(row.key_version)} WHERE name = 'anthropic'`);
}
