/**
 * The recovery configuration contract: the one reader of a hosted Deployment's recorded configuration, the one reader of
 * a recorded fleet, and the bound configuration a Deployment's own producer records, held to every setting its runtime
 * binds on its own.
 */
import { describe, expect, it } from 'bun:test';
import { readHostedRecoveryConfiguration, recordedFleet } from '@myco-server-worker/core/recovery-staging.js';
import { boundRecoveryConfiguration } from '@myco-server-worker/platform/cloudflare/recovery-export.js';

const CONFIGURATION = {
  accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111', databaseName: 'fixture-db', workerName: 'fixture-worker',
  bucketName: 'fixture-blobs', recoveryBucketName: 'fixture-worker-recovery', vectorIndexName: 'fixture-vectors', wrapKeySecretName: 'fixture-wrap',
};

describe('recordedFleet', () => {
  it('reads a whole number of runtimes, and reads an absent fleet as none recorded', () => {
    expect(recordedFleet({ fleet: 3 })).toBe(3);
    expect(recordedFleet({})).toBeNull();
    expect(recordedFleet({ fleet: undefined })).toBeNull();
    expect(recordedFleet({ startedBy: 'mem_1' })).toBeNull();
  });

  it.each([[0], [-1], [1.5], ['3'], [null], [true]])('refuses a recorded fleet of %p', (fleet) => {
    expect(() => recordedFleet({ fleet })).toThrow('not a whole number of runtimes');
  });
});

describe('readHostedRecoveryConfiguration', () => {
  it('accepts the public record, with and without its optional settings', () => {
    expect(readHostedRecoveryConfiguration(CONFIGURATION)).toEqual({ ok: true, configuration: CONFIGURATION });
    const full = { ...CONFIGURATION, storeId: 'b'.repeat(32), url: 'https://example.test', fleet: 4 };
    expect(readHostedRecoveryConfiguration(full)).toEqual({ ok: true, configuration: full });
  });

  it.each([
    ['a non-object', 'fixture'],
    ['an array', [CONFIGURATION]],
    ['a missing name', { ...CONFIGURATION, recoveryBucketName: undefined }],
    ['an empty name', { ...CONFIGURATION, databaseName: '' }],
    ['a name that is not a string', { ...CONFIGURATION, workerName: 7 }],
    ['an empty store id', { ...CONFIGURATION, storeId: '' }],
    ['a malformed fleet', { ...CONFIGURATION, fleet: 0 }],
    ['a field outside the public record', { ...CONFIGURATION, SESSION_SECRET: 'sentinel-session-secret' }],
  ])('refuses %s', (_label, value) => {
    const read = readHostedRecoveryConfiguration(value);
    expect(read.ok).toBe(false);
    expect(JSON.stringify(read)).not.toContain('sentinel-session-secret');
  });
});

describe('boundRecoveryConfiguration', () => {
  const bindings = (overrides: Record<string, string | undefined> = {}) => ({
    MYCO_RECOVERY_CONFIGURATION: JSON.stringify(CONFIGURATION),
    MYCO_RECOVERY_ACCOUNT_ID: CONFIGURATION.accountId,
    MYCO_RECOVERY_DATABASE_ID: CONFIGURATION.databaseId,
    ...overrides,
  });
  const withSettings = { ...CONFIGURATION, fleet: 4, url: 'https://myco.example.test/path' };

  it('reads a configuration that agrees with every setting the runtime binds', () => {
    expect(boundRecoveryConfiguration(bindings())).toEqual({ ok: true, configuration: CONFIGURATION });
    expect(boundRecoveryConfiguration(bindings({
      MYCO_RECOVERY_CONFIGURATION: JSON.stringify(withSettings), MYCO_FLEET: '4', MYCO_ORIGIN: 'https://myco.example.test',
    }))).toEqual({ ok: true, configuration: withSettings });
  });

  it.each([
    ['no rendered configuration', { MYCO_RECOVERY_CONFIGURATION: undefined }, 'carries no recovery configuration'],
    ['an empty rendered configuration', { MYCO_RECOVERY_CONFIGURATION: '' }, 'carries no recovery configuration'],
    ['an unreadable rendered configuration', { MYCO_RECOVERY_CONFIGURATION: '{"accountId":' }, 'not readable'],
    ['another export account', { MYCO_RECOVERY_ACCOUNT_ID: 'c'.repeat(32) }, 'another account or database'],
    ['another export database', { MYCO_RECOVERY_DATABASE_ID: '22222222-2222-4222-8222-222222222222' }, 'another account or database'],
    ['a runtime fleet the configuration does not record', { MYCO_FLEET: '4' }, 'another fleet'],
    ['a recorded fleet the runtime does not run with', { MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ ...CONFIGURATION, fleet: 4 }) }, 'another fleet'],
    ['a stale recorded fleet', { MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ ...CONFIGURATION, fleet: 4 }), MYCO_FLEET: '2' }, 'another fleet'],
    ['a runtime origin the configuration does not record', { MYCO_ORIGIN: 'https://myco.example.test' }, 'another address'],
    ['a recorded address the runtime does not run at', { MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ ...CONFIGURATION, url: 'https://myco.example.test' }) }, 'another address'],
    ['a stale recorded address', { MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ ...CONFIGURATION, url: 'https://old.example.test' }), MYCO_ORIGIN: 'https://myco.example.test' }, 'another address'],
    ['a recorded address that is not a URL', { MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ ...CONFIGURATION, url: 'not a url' }) }, 'not a URL'],
  ])('is not ready with %s', (_label, overrides, reason) => {
    const bound = boundRecoveryConfiguration(bindings(overrides));
    expect(bound.ok).toBe(false);
    expect(bound.ok ? '' : bound.reason).toContain(reason);
  });
});
