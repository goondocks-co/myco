import { RecoveryProducer as ProductProducer } from '@myco-server-worker/platform/cloudflare/recovery-producer-object.js';
import { capturedDefinitions, PRODUCER_STALL_MS, type ProducerLimits } from '@myco-server-worker/core/recovery-producer.js';
import { handleRecoveryExportStatus } from '@myco-server-worker/api/recovery.js';
import { serverEnvFromBindings, type CloudflareBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { events, writes } from './recovery-alarm-observer.js';

export const SCHEMA = [
  { storage: 'table', sql: 'CREATE TABLE example(id INTEGER)' },
  { storage: 'table', sql: 'CREATE TABLE backups(key TEXT,size_bytes INTEGER,sha256 TEXT)' },
];
const arrayBuffer = Response.prototype.arrayBuffer;
Response.prototype.arrayBuffer = function () {
  if (this.headers.has('content-range')) throw new Error('a ranged export must remain streamed');
  return arrayBuffer.call(this);
};
const uploads: Array<{ id: string; part: number }> = [];
const streamChecks: Array<{ part: number; bytes: number }> = [];
let rangeRead: { pulled: number; length: number } | null = null;
const sourceFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const response = await sourceFetch(input, init);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  if (range === null || response.body === null) return response;
  const held = { pulled: 0, length: Number(range[2]) - Number(range[1]) + 1 };
  rangeRead = held;
  const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { held.pulled += chunk.byteLength; controller.enqueue(chunk); },
  }));
  return new Response(observed, response);
}) as typeof fetch;

type Bindings = CloudflareBindings & { TEST_HANG_PART: number; TEST_PART_BYTES: number; TEST_READ_AHEAD_BYTES: number };

export class RecoveryProducer extends ProductProducer {
  constructor(ctx: DurableObjectState, env: Bindings) {
    const bucket = env.RECOVERY_BUCKET!;
    const observed = new Proxy(bucket, {
      get(target, property) {
        if (property === 'resumeMultipartUpload') return (key: string, id: string) => {
          const upload = bucket.resumeMultipartUpload(key, id);
          return {
            ...upload,
            abort: () => upload.abort(),
            complete: (parts: R2UploadedPart[]) => upload.complete(parts),
            async uploadPart(part: number, body: ReadableStream<Uint8Array> | Uint8Array) {
              uploads.push({ id, part });
              if (!(body instanceof ReadableStream)) throw new Error('an upload must stream');
              const held = rangeRead;
              if (held === null) throw new Error('an upload requires a ranged source');
              let first = true;
              const observed = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  if (first) {
                    streamChecks.push({ part, bytes: held.pulled });
                    if (held.pulled > env.TEST_READ_AHEAD_BYTES) throw new Error('an upload buffered its source before consuming its first chunk');
                    first = false;
                  }
                  controller.enqueue(chunk);
                },
              })).pipeThrough(new FixedLengthStream(held.length));
              if (part === env.TEST_HANG_PART) {
                const reader = observed.getReader();
                await reader.read();
                await reader.cancel();
                return new Promise<R2UploadedPart>(() => {});
              }
              return upload.uploadPart(part, observed);
            },
          };
        };
        if (property === 'put') return async (...args: Parameters<typeof bucket.put>) => {
          writes.push(args[0]);
          return bucket.put(...args);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, RECOVERY_BUCKET: observed });
  }

  async start() {
    return this.admit({ holdToken: 'stream-fixture', startedBy: 'fixture-owner', tables: ['example', 'backups'],
      schema: JSON.stringify(SCHEMA), captured: capturedDefinitions(SCHEMA) });
  }

  async advance() {
    const env = this.env as Bindings;
    return this.continue({ partBytes: env.TEST_PART_BYTES } as ProducerLimits);
  }

  async abandon() {
    this.ctx.storage.sql.exec('UPDATE attempts SET last_progress_at = ?', Date.now() - PRODUCER_STALL_MS - 1);
    return this.settleHold('stream-fixture');
  }
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const producer = env.RECOVERY!.get(env.RECOVERY!.idFromName('recovery')) as unknown as RecoveryProducer;
    const path = new URL(request.url).pathname;
    if (path === '/start') return Response.json(await producer.start());
    if (path === '/step') return Response.json(await producer.advance());
    if (path === '/abandon') return Response.json(await producer.abandon());
    if (path === '/events') return Response.json(events);
    if (path === '/uploads') return Response.json(uploads);
    if (path === '/stream-checks') return Response.json(streamChecks);
    if (path === '/writes') return Response.json(writes);
    if (path === '/api/recovery/exports') {
      return handleRecoveryExportStatus(serverEnvFromBindings(env), { now: Date.now(), member: { role: 'admin' } } as never);
    }
    return new Response('not found', { status: 404 });
  },
};
