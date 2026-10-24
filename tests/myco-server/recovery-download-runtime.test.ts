import { expect, it } from 'bun:test';
import { finishStreamedRecovery, SOURCE_READ_AHEAD_BYTES, streamedRecovery } from './helpers/recovery-download-fixture.js';

for (const bundled of [false, true]) it('workerd ' + (bundled ? 'deployable bundle' : 'source') + ' streams a complete recovery and verifies its manifest and staged objects', async () => {
  const fixture = await streamedRecovery(17 * 1024 * 1024, 5 * 1024 * 1024, bundled);
  try {
    await fixture.call('/start');
    const status = await finishStreamedRecovery(fixture);
    expect(status.staged).toMatchObject({ downloadedBytes: fixture.total, sqlBytes: fixture.total, objects: { registered: 1, staged: 1 } });
    const bucket = await fixture.bucket();
    const manifest = await (await bucket.get(status.staged!.prefix + '/recovery.json'))!.json() as import('@myco-server-worker/core/recovery-staging.js').RecoveryStagingManifest;
    expect(manifest.status).toBe('complete');
    expect(manifest.database).toMatchObject({ sha256: fixture.digest(), bytes: fixture.total });
    expect(manifest.objects).toHaveLength(1);
    expect(manifest.objects[0]!.sha256).toBe(fixture.sourceDigest);
    expect((await bucket.list({ prefix: status.staged!.prefix + '/objects/' })).objects).toHaveLength(1);
    expect(status.inFlight).toBeNull();
    const reads = await fixture.call<Array<{ bytes: number }>>('/stream-checks');
    expect(reads).toHaveLength(status.staged!.parts);
    expect(reads.every(read => read.bytes <= SOURCE_READ_AHEAD_BYTES)).toBe(true);
  } finally { await fixture.close(); }
}, 60_000);

it('workerd resumes an interrupted seventh part without rereading committed parts or duplicating objects', async () => {
  const part = 5 * 1024 * 1024;
  const fixture = await streamedRecovery(7 * part + 1024, part);
  try {
    await fixture.call('/start');
    await fixture.call('/step');
    for (let i = 0; i < 6; i++) await fixture.call('/step');
    const before = await fixture.status();
    expect(before.staged!.parts).toBe(6);
    const uploadId = (await fixture.call<Array<{ id: string }>>('/uploads'))[0]!.id;
    await fixture.restart(7);
    const lost = fixture.call('/step').catch(() => undefined);
    const deadline = Date.now() + 10_000;
    let status = await fixture.status();
    while (status.inFlight?.name !== 'upload part 7' && Date.now() < deadline) { await Bun.sleep(10); status = await fixture.status(); }
    expect(status.inFlight?.name).toBe('upload part 7');
    expect(status.staged!.downloadedBytes).toBe(6 * part);
    const resumeIndex = fixture.ranges.length;
    await fixture.restart();
    await lost;
    const completed = await finishStreamedRecovery(fixture);
    expect(completed.attempt).toBe(before.attempt);
    const uploads = await fixture.call<Array<{ id: string; part: number }>>('/uploads');
    expect(uploads[0]).toEqual({ id: uploadId, part: 7 });
    expect(uploads.every(upload => upload.id === uploadId)).toBe(true);
    expect(fixture.ranges.slice(resumeIndex).every(offset => offset >= 6 * part)).toBe(true);
    expect(completed.staged!.objects).toEqual({ registered: 1, staged: 1 });
    const bucket = await fixture.bucket();
    expect((await bucket.list({ prefix: completed.staged!.prefix + '/objects/' })).objects).toHaveLength(1);
  } finally { await fixture.close(); }
}, 90_000);

it('workerd fails a genuinely abandoned seventh upload and names it in the status and stall detail', async () => {
  const part = 5 * 1024 * 1024;
  const fixture = await streamedRecovery(8 * part, part);
  try {
    await fixture.call('/start');
    await fixture.call('/step');
    for (let i = 0; i < 6; i++) await fixture.call('/step');
    await fixture.restart(7);
    const lost = fixture.call('/step').catch(() => undefined);
    const deadline = Date.now() + 10_000;
    let status = await fixture.status();
    while (status.inFlight?.name !== 'upload part 7' && Date.now() < deadline) { await Bun.sleep(10); status = await fixture.status(); }
    expect(status.inFlight).toMatchObject({ name: 'upload part 7', startedAt: expect.any(Number) });
    await fixture.restart();
    await lost;
    await fixture.call('/abandon');
    status = await fixture.status();
    expect(status.error).toBe('producer_stalled');
    expect(status.stage).toBe('failed');
    expect(status.inFlight?.name).toBe('upload part 7');
    const events = await fixture.call<Array<Record<string, unknown>>>('/events');
    expect(events.find(event => event.kind === 'recovery_attempt_failed')).toMatchObject({
      refusal: 'producer_stalled', operation: 'upload part 7', operationStartedAt: status.inFlight!.startedAt, idleMs: expect.any(Number),
    });
  } finally { await fixture.close(); }
}, 90_000);
