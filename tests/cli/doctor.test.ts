import { describe, it, expect } from 'vitest';
import { type DoctorCheck, runChecks } from '@myco/cli/doctor';

describe('runChecks', () => {
  it('returns vault check failure when myco.yaml missing', async () => {
    const checks = await runChecks('/tmp/nonexistent-vault-' + Date.now());
    const vaultCheck = checks.find((c) => c.name === 'Vault');
    expect(vaultCheck).toBeDefined();
    expect(vaultCheck!.status).toBe('fail');
  });

  it('returns all expected check names', async () => {
    const checks = await runChecks('/tmp/nonexistent-vault-' + Date.now());
    const names = checks.map((c) => c.name);
    expect(names).toContain('Vault');
    expect(names).toContain('Database');
    expect(names).toContain('Embeddings');
    expect(names).toContain('Agents');
    expect(names).toContain('Daemon');
  });
});
