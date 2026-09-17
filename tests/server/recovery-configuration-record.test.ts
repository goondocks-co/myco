/**
 * The operator side of the recovery configuration: the one mapping from a deployment record, the rendered bindings a
 * Deployment's own producer reads it back from, the one credential list, and what a restore says about what it carries.
 */
import { describe, expect, it } from 'bun:test';
import { RECOVERY_CREDENTIAL_NAMES } from '@myco-server-worker/core/recovery-staging.js';
import { boundRecoveryConfiguration } from '@myco-server-worker/platform/cloudflare/recovery-export.js';
import { recoveryConfigurationOf } from '@myco/server/cloudflare-resources.js';
import { renderDeployConfig } from '@myco/server/deploy-config.js';
import { LOCAL_SECRET_NAMES } from '@myco/server/local.js';
import { credentialsReport, restoredFleet } from '@myco/server/recovery-bundle.js';
import type { DeploymentRecord } from '@myco/server/cloudflare.js';

const minimal: DeploymentRecord = {
  accountId: 'fixture-account', workerName: 'fixture-worker', databaseName: 'fixture-db', bucketName: 'fixture-blobs',
  versionId: 'fixture-version', deployedAt: '2026-09-17T00:00:00.000Z', databaseId: 'fixture-database',
};
const full: DeploymentRecord = {
  ...minimal, storeId: 'fixture-store', url: 'https://myco.example.test/app', fleet: 3,
  vectorIndexName: 'fixture-vectors', wrapKeySecretName: 'fixture-wrap', recoveryBucketName: 'fixture-recovery',
};

/** The bindings a rendered deploy config gives the Worker. */
const renderedVars = (record: DeploymentRecord): Record<string, string> =>
  (Bun.TOML.parse(renderDeployConfig(record)) as { vars: Record<string, string> }).vars;

describe('recoveryConfigurationOf', () => {
  it('records the resolved resource names, including the derived recovery store and default index and secret', () => {
    expect(recoveryConfigurationOf(minimal)).toEqual({
      accountId: 'fixture-account', databaseId: 'fixture-database', databaseName: 'fixture-db', workerName: 'fixture-worker',
      bucketName: 'fixture-blobs', recoveryBucketName: 'fixture-worker-recovery', vectorIndexName: 'myco-server-memory', wrapKeySecretName: 'myco-secret-wrap-key',
    });
    expect(recoveryConfigurationOf(full)).toEqual({
      accountId: 'fixture-account', databaseId: 'fixture-database', databaseName: 'fixture-db', workerName: 'fixture-worker',
      bucketName: 'fixture-blobs', recoveryBucketName: 'fixture-recovery', vectorIndexName: 'fixture-vectors', wrapKeySecretName: 'fixture-wrap',
      storeId: 'fixture-store', url: 'https://myco.example.test/app', fleet: 3,
    });
  });

  it('refuses a record that names no database', () => {
    expect(() => recoveryConfigurationOf({ ...minimal, databaseId: undefined })).toThrow('names no database id');
  });

  it.each([['a minimal record', minimal], ['a record with every setting', full], ['a record with a fleet and no address', { ...minimal, fleet: 2 }]])(
    'renders %s so the Deployment\'s own producer reads back exactly the operator\'s mapping, agreeing with its runtime settings',
    (_label, record) => {
      const vars = renderedVars(record);
      expect(boundRecoveryConfiguration(vars)).toEqual({ ok: true, configuration: recoveryConfigurationOf(record) });
    },
  );

  it('renders public record metadata only: nothing a record carries beyond its public fields reaches the rendered configuration', () => {
    const record = { ...full, unexpectedCredential: 'sentinel-record-secret' } as DeploymentRecord;
    const rendered = renderedVars(record).MYCO_RECOVERY_CONFIGURATION!;
    expect(rendered).not.toContain('sentinel-record-secret');
    for (const value of ['fixture-account', 'fixture-database', 'fixture-recovery', 'fixture-store', 'https://myco.example.test/app']) expect(rendered).toContain(value);
  });
});

describe('credential names', () => {
  it('are one list: the native secrets file order is the recovery requirement', () => {
    expect(LOCAL_SECRET_NAMES).toBe(RECOVERY_CREDENTIAL_NAMES);
  });

  it.each([
    [[], 'This artifact records no required credentials. Recovery needs these, kept separately: SECRET_WRAP_KEY, SESSION_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET'],
    [[...RECOVERY_CREDENTIAL_NAMES], 'Keep these credentials separately for recovery: SECRET_WRAP_KEY, SESSION_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET'],
    [['MYCO_WRAP_KEY'], 'Keep these credentials separately for recovery: MYCO_WRAP_KEY. Recovery also needs: SECRET_WRAP_KEY, SESSION_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET'],
  ])('report what an artifact recording %p records and what recovery needs', (recorded, line) => {
    expect(credentialsReport(recorded)).toBe(line);
  });
});

describe('restoredFleet', () => {
  it('carries a recorded fleet and says so', () => {
    for (const configuration of [{ fleet: 3 }, { ...recoveryConfigurationOf(full) }, { port: 8787, fleet: 3 }]) {
      const carried = restoredFleet(configuration);
      expect(carried).toEqual({ fleet: 3, report: 'Recorded fleet 3 carried to the restored Deployment.' });
      expect(carried.report).not.toContain('unknown');
    }
  });

  it('says an artifact that records no fleet leaves its source fleet unknown, whatever else it records', () => {
    for (const configuration of [{}, { startedBy: 'mem_1' }, { port: 8787 }, recoveryConfigurationOf(minimal)]) {
      expect(restoredFleet(configuration)).toEqual({
        fleet: null,
        report: 'The artifact records no fleet, so its source fleet is unknown; the restored Deployment is published without one, and dispatch applies no fleet bound.',
      });
    }
  });

  it('refuses a recorded fleet that is not a whole number of runtimes', () => {
    expect(() => restoredFleet({ fleet: 'local' })).toThrow('not a whole number of runtimes');
  });
});
