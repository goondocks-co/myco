import { test } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentIdentity } from '@myco-server-worker/auth/authorization.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { rawPrivacy } from '../parity/scenarios/raw-privacy.js';
import { storageCleanupParity } from '../parity/scenarios/storage-cleanup.js';
import { GITHUB_SUB, MEMBER_ID, SESSION_SECRET, grantHeadersFor, memberHeadersFor, type ParityScenario, type ParityTarget } from '../parity/harness.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';

async function onDocumentStores(scenario: ParityScenario): Promise<void> {
  await withDocumentStores(async (db, store) => {
    const now = Date.now();
    await ensureMember(db, MEMBER_ID, now, 'admin');
    await db.prepare('UPDATE members SET github_id=? WHERE id=?').bind(GITHUB_SUB, MEMBER_ID).run();
    const issued = await issueMemberToken(db, { memberId: MEMBER_ID, machineId: 'machine_parity' }, now);
    const deploymentId = await deploymentIdentity(db);
    const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: deploymentId, sub: GITHUB_SUB, login: 'fixture', iat: now, exp: now + 3_600_000 })}`;
    const bindings = { MYCO_DB: db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter(),
      GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture', SESSION_SECRET };
    const env = serverEnvFromBindings(bindings);
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => worker.fetch(request, bindings) });
    const target: ParityTarget = {
      name: store === 'native' ? 'selfhosted' : 'cloudflare', url: server.url.origin, deploymentId, projectId: 'project', memberToken: issued.token,
      bindings: { database: store, blob: 'memory', secret: 'fixture', vector: null },
      ownerHeaders: () => ({ cookie, 'cf-connecting-ip': '1.2.3.4' }),
      memberHeaders: extra => memberHeadersFor(issued.token, 'project', extra), grantHeaders: grantHeadersFor,
      sql: async sql => (await db.prepare(sql).all<Record<string, unknown>>()).results,
      clockWake: async (at = Date.now()) => { await runTick(env, at, { wake: 'clock' }); },
      stop: async () => { await server.stop(true); },
    };
    try { await scenario.run(target); }
    finally { await target.stop(); }
  });
}

test('shared spilled plans retain the raw privacy contract through editorial saves on SQLite and D1', async () => {
  await onDocumentStores(rawPrivacy);
});

test('archival retains complete document content and usable locators on SQLite and D1', async () => {
  await onDocumentStores(storageCleanupParity);
});
