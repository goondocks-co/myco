import { RecoveryProducer as ProductProducer } from '@myco-server-worker/platform/cloudflare/recovery-producer-object.js';
import type { CloudflareBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { stagedSqlKey } from '@myco-server-worker/core/recovery-producer.js';

export class RecoveryProducer extends ProductProducer {
  private readonly testBucket: R2Bucket;
  constructor(ctx: DurableObjectState, env: CloudflareBindings & { RECOVERY_BUCKET: R2Bucket }) {
    const bucket = env.RECOVERY_BUCKET!;
    const observed = new Proxy(bucket, {
      get(target, property) {
        if (property === 'resumeMultipartUpload') return (key: string, uploadId: string) => {
          const upload = bucket.resumeMultipartUpload(key, uploadId);
          return { ...upload, abort: async () => { await upload.abort(); await ctx.storage.put('aborted', true); } };
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, RECOVERY_BUCKET: observed });
    this.testBucket = bucket;
  }

  async probe() {
    const admitted = await this.admit({ holdToken: 'schema-drift', tables: ['example'], schema: '[]',
      captured: { example: 'CREATE TABLE example(id INTEGER)' }, startedBy: 'member' });
    const prefix = this.ctx.storage.sql.exec<{ prefix: string }>('SELECT prefix FROM attempts WHERE id=?', admitted.attempt!).one().prefix;
    const upload = await this.testBucket.createMultipartUpload(stagedSqlKey(prefix));
    const part = await upload.uploadPart(1, new Uint8Array([1, 2, 3, 4]));
    this.ctx.storage.sql.exec("UPDATE attempts SET stage='download',upload_id=? WHERE id=?", upload.uploadId, admitted.attempt!);
    this.ctx.storage.sql.exec('INSERT INTO parts(attempt,part,bytes,sha256,etag) VALUES(?,1,4,?,?)', admitted.attempt!, 'a'.repeat(64), part.etag);
    await this.noteSchemaDrift(admitted.attempt!);
    return {
      aborted: await this.ctx.storage.get('aborted'),
      attempt: this.ctx.storage.sql.exec('SELECT stage,upload_id FROM attempts').one(),
      parts: this.ctx.storage.sql.exec('SELECT * FROM parts').toArray(),
    };
  }
}

export default {
  async fetch(_request: Request, env: { RECOVERY: DurableObjectNamespace<RecoveryProducer> }) {
    return Response.json(await env.RECOVERY.get(env.RECOVERY.idFromName('test')).probe());
  },
};
