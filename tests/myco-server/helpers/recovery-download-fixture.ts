import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { BUNDLED_WORKER } from '@myco/worker-bundle.generated.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { RecoveryProducerStatus } from '@myco-server-worker/core/recovery-producer.js';

export const SOURCE_READ_AHEAD_BYTES = 1024 * 1024;

export async function streamedRecovery(total: number, partBytes: number, bundled = false) {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-stream-'));
  const observer = path.join(import.meta.dir, 'recovery-alarm-observer.ts');
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, 'recovery-download-entry.ts')], target: 'browser', format: 'esm',
    external: ['cloudflare:workers', './product.js'],
    plugins: [{ name: 'recovery-observer', setup(builder) {
      if (bundled) builder.onLoad({ filter: /recovery-download-entry\.ts$/ }, args => ({
        loader: 'ts', contents: fs.readFileSync(args.path, 'utf8')
          .replace("from '@myco-server-worker/platform/cloudflare/recovery-producer-object.js'", "from './product.js'"),
      }));
      builder.onResolve({ filter: /^\.\/product\.js$/ }, () => ({ path: './product.js', external: true }));
      builder.onResolve({ filter: /(?:^|\/)telemetry\.js$/ }, args => args.importer === observer ? undefined : { path: observer });
    } }],
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const sourceObject = new TextEncoder().encode('retained recovery object');
  const sourceDigest = new Bun.CryptoHasher('sha256').update(sourceObject).digest('hex');
  const head = new TextEncoder().encode(
    'CREATE TABLE example(id INTEGER);\nCREATE TABLE backups(key TEXT,size_bytes INTEGER,sha256 TEXT);\n'
    + "INSERT INTO backups VALUES('backups/fixture.jsonl'," + sourceObject.length + ",'" + sourceDigest + "');\n",
  );
  const ranges: number[] = [];
  let generated = 0;
  const hash = new Bun.CryptoHasher('sha256');
  const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request): Response {
    if (new URL(request.url).pathname.endsWith('/export')) return Response.json({ success: true, result: {
      status: 'complete', at_bookmark: 'fixture-bookmark', result: { signed_url: 'http://127.0.0.1:' + provider.port + '/data' },
    } });
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '');
    if (range === null) return new Response('range required', { status: 400 });
    const start = Number(range[1]), end = Math.min(Number(range[2]), total - 1);
    ranges.push(start);
    let position = start;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (position > end) { controller.close(); return; }
        const chunk = new Uint8Array(Math.min(64 * 1024, end + 1 - position)).fill(32);
        if (position < head.length) chunk.set(head.subarray(position, Math.min(head.length, position + chunk.length)));
        if (position === generated) { hash.update(chunk); generated += chunk.length; }
        position += chunk.length;
        controller.enqueue(chunk);
      },
    }), { status: 206, headers: { 'content-range': 'bytes ' + start + '-' + end + '/' + total, etag: 'fixture-export' } });
  } });
  const contents = await build.outputs[0]!.text();
  let mf: Miniflare;
  async function boot(hangPart: number) {
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: [{ type: 'ESModule', path: 'worker.js', contents },
        ...(bundled ? [{ type: 'ESModule' as const, path: 'product.js', contents: Buffer.from(BUNDLED_WORKER, 'base64').toString('utf8') }] : [])],
      compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['MYCO_DB'], r2Buckets: ['BUCKET', 'RECOVERY_BUCKET'],
      name: 'recovery-download-fixture', resourcePersistencePath: persist,
      durableObjects: { RECOVERY: { className: 'RecoveryProducer', useSQLite: true } },
      bindings: {
        HARNESS_LAUNCH_MODE: 'record', MYCO_RECOVERY_API_ORIGIN: 'http://127.0.0.1:' + provider.port,
        MYCO_RECOVERY_ACCOUNT_ID: 'fixture-account', MYCO_RECOVERY_DATABASE_ID: 'fixture-database', RECOVERY_EXPORT_TOKEN: 'local-fake-token',
        TEST_HANG_PART: hangPart, TEST_PART_BYTES: partBytes, TEST_READ_AHEAD_BYTES: SOURCE_READ_AHEAD_BYTES,
        MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ accountId: 'fixture-account', databaseId: 'fixture-database', databaseName: 'fixture-db',
          workerName: 'fixture-worker', bucketName: 'fixture-blobs', recoveryBucketName: 'fixture-recovery',
          vectorIndexName: 'fixture-vectors', wrapKeySecretName: 'fixture-wrap' }),
      },
    }));
    await mf.ready;
  }
  try {
    await boot(0);
    const db = await mf!.getD1Database('MYCO_DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    await (await mf!.getR2Bucket('BUCKET')).put('backups/fixture.jsonl', sourceObject);
  } catch (error) { await mf!.dispose(); provider.stop(true); throw error; }
  const call = async <T>(route: string): Promise<T> => {
    const response = await mf.dispatchFetch('http://local' + route);
    if (!response.ok) throw new Error('fixture route failed: ' + route + ' ' + response.status);
    return response.json() as Promise<T>;
  };
  return {
    call, ranges, total, partBytes, sourceDigest,
    status: () => call<RecoveryProducerStatus>('/api/recovery/exports'),
    restart: async (hangPart = 0) => { await mf.dispose(); await boot(hangPart); },
    bucket: () => mf.getR2Bucket('RECOVERY_BUCKET'),
    digest: () => { if (generated !== total) throw new Error('source hash is incomplete'); return hash.digest('hex'); },
    close: async () => { await mf.dispose(); provider.stop(true); fs.rmSync(persist, { recursive: true, force: true }); },
  };
}

export async function finishStreamedRecovery(fixture: Awaited<ReturnType<typeof streamedRecovery>>, runtimeMs = 600_000) {
  let status = await fixture.status();
  const deadline = Date.now() + runtimeMs;
  while (!['complete', 'failed'].includes(status.stage) && Date.now() < deadline) {
    const ranges = fixture.ranges.length;
    await fixture.call('/step');
    if (fixture.ranges.length - ranges > 1) throw new Error('a continuation downloaded more than one part');
    const reads = await fixture.call<Array<{ bytes: number }>>('/stream-checks');
    if (reads.some(read => read.bytes > SOURCE_READ_AHEAD_BYTES)) throw new Error('an upload read ahead beyond its bounded first chunk');
    status = await fixture.status();
  }
  if (status.stage !== 'complete') throw new Error('streamed recovery did not complete: ' + JSON.stringify(status));
  return status;
}
