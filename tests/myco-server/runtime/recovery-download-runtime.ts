import assert from 'node:assert/strict';
import { streamedRecovery, finishStreamedRecovery } from '../helpers/recovery-download-fixture.js';
import { STAGING_MANIFEST_FILE, STAGING_SQL_FILE, type RecoveryStagingManifest } from '@myco-server-worker/core/recovery-staging.js';
import { PRODUCER_LIMITS } from '@myco-server-worker/core/recovery-producer.js';

const total = 3_000_000_000;
const started = performance.now();
const fixture = await streamedRecovery(total, PRODUCER_LIMITS.partBytes);
try {
  await fixture.call('/start');
  const status = await finishStreamedRecovery(fixture, 30 * 60_000);
  assert.equal(status.staged!.downloadedBytes, total);
  assert.equal(status.staged!.sqlBytes, total);
  assert.deepEqual(status.staged!.objects, { registered: 1, staged: 1 });
  const bucket = await fixture.bucket();
  const manifest = await (await bucket.get(status.staged!.prefix + '/' + STAGING_MANIFEST_FILE))!.json() as RecoveryStagingManifest;
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.database!.sha256, fixture.digest());
  assert.equal(manifest.database!.bytes, total);
  assert.equal((await bucket.head(status.staged!.prefix + '/' + STAGING_SQL_FILE))!.size, total);
  assert.equal(manifest.objects.length, 1);
  assert.equal(manifest.objects[0]!.sha256, fixture.sourceDigest);
  assert.equal((await bucket.list({ prefix: status.staged!.prefix + '/objects/' })).objects.length, 1);
  assert.equal(fixture.ranges.length, Math.ceil(total / PRODUCER_LIMITS.partBytes));
  console.log(JSON.stringify({ total, elapsedMs: Math.round(performance.now() - started), ranges: fixture.ranges.length, status, manifest }));
} finally { await fixture.close(); }
