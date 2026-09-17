/**
 * The admission as it travels between a Worker and the producer object. Worker and producer object code do not change
 * together, so the Cloudflare port sends a wire that a producer object of either release reads, and a producer object
 * reads who started the attempt from either wire shape.
 */
import { describe, expect, it } from 'bun:test';
import { openStagingManifest, type RecoveryAdmission } from '@myco-server-worker/core/recovery-producer.js';
import { RECOVERY_CREDENTIAL_NAMES } from '@myco-server-worker/core/recovery-staging.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { admittedStarter, recoveryAdmissionWire, type RecoveryAdmissionWire } from '@myco-server-worker/platform/cloudflare/recovery-export.js';
import { sqliteEnv } from './helpers/fixtures.js';

const CONFIGURATION = {
  accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111', databaseName: 'fixture-db', workerName: 'fixture-worker',
  bucketName: 'fixture-blobs', recoveryBucketName: 'fixture-worker-recovery', vectorIndexName: 'fixture-vectors', wrapKeySecretName: 'fixture-wrap',
};
const BOUND = {
  MYCO_RECOVERY_ACCOUNT_ID: CONFIGURATION.accountId, MYCO_RECOVERY_DATABASE_ID: CONFIGURATION.databaseId,
  MYCO_RECOVERY_CONFIGURATION: JSON.stringify(CONFIGURATION),
};
const ADMISSION: RecoveryAdmission = {
  holdToken: 'token-1', tables: ['sessions'], schema: '[]', captured: { sessions: 'CREATE TABLE sessions (id TEXT)' }, startedBy: 'mem_owner',
};

/** A Cloudflare server env whose producer object records every admission it is sent. */
function portOver(bindings: Record<string, string | undefined>) {
  const sent: RecoveryAdmissionWire[] = [];
  const object = { admit: async (wire: RecoveryAdmissionWire) => { sent.push(wire); return { attempt: 1, stage: 'export' }; } };
  const e = sqliteEnv();
  const env = serverEnvFromBindings({
    ...e.env, ...bindings,
    RECOVERY: { idFromName: (name: string) => name, get: () => object },
    RECOVERY_BUCKET: {},
  } as never);
  return { e, recovery: env.recovery!, sent };
}

describe('the Cloudflare port', () => {
  it('sends a wire carrying who started the attempt and the recorded configuration and credential names', async () => {
    const { e, recovery, sent } = portOver(BOUND);
    try {
      expect(recovery.admission).toEqual({ ready: true });
      await recovery.admit(ADMISSION);
      expect(sent).toEqual([{
        ...ADMISSION,
        configuration: { ...CONFIGURATION, startedBy: 'mem_owner' },
        credentialsRequired: [...RECOVERY_CREDENTIAL_NAMES],
      }]);
    } finally { e.sqlite.close(); }
  });

  it('sends a wire a producer object of the previous release stages whole: it reads the recorded fields, not who started it', () => {
    const wire = recoveryAdmissionWire(ADMISSION, BOUND);
    // The previous release's object opens its staging from the admission's own configuration and credential names.
    const manifest = openStagingManifest({
      target: 'cloudflare', locator: 'account/database', startedAt: 0, schema: { sha256: 'a'.repeat(64), bytes: 2 },
      configuration: wire.configuration!, credentialsRequired: wire.credentialsRequired!, bookmark: null,
    });
    expect([manifest.configuration, manifest.credentialsRequired]).toEqual([{ ...CONFIGURATION, startedBy: 'mem_owner' }, [...RECOVERY_CREDENTIAL_NAMES]]);
  });

  it('still sends an admission when the Worker cannot read its own configuration, recording nothing and saying why', async () => {
    const { e, recovery, sent } = portOver({ ...BOUND, MYCO_RECOVERY_CONFIGURATION: undefined });
    try {
      expect(recovery.admission.ready).toBe(false);
      await recovery.admit(ADMISSION);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ ...ADMISSION, unrecordable: expect.stringContaining('carries no recovery configuration') });
      expect('configuration' in sent[0]! || 'credentialsRequired' in sent[0]!).toBe(false);
    } finally { e.sqlite.close(); }
  });
});

describe('admittedStarter', () => {
  it('reads who started the attempt from either wire shape', () => {
    expect(admittedStarter({ ...ADMISSION })).toBe('mem_owner');
    const { startedBy: _startedBy, ...previous } = ADMISSION;
    expect(admittedStarter({ ...previous, configuration: { startedBy: 'previous-owner' }, credentialsRequired: [] })).toBe('previous-owner');
    expect(admittedStarter({ ...ADMISSION, startedBy: '', configuration: { startedBy: 'previous-owner' } })).toBe('previous-owner');
  });

  it('refuses an admission that names no one', () => {
    const { startedBy: _startedBy, ...previous } = ADMISSION;
    expect(() => admittedStarter(previous)).toThrow('names no member');
    expect(() => admittedStarter({ ...previous, configuration: {} })).toThrow('names no member');
  });
});
