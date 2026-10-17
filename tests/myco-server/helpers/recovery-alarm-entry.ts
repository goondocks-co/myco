import worker from '@myco-server-worker/index.js';
import { DeploymentClock as ProductClock, clockStub } from '@myco-server-worker/platform/cloudflare/deployment-clock.js';
import { RecoveryProducer as ProductProducer } from '@myco-server-worker/platform/cloudflare/recovery-producer-object.js';
import { serverEnvFromBindings, type CloudflareBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { recoveryScheduleOf } from '@myco-server-worker/core/recovery-schedule.js';
import { STAGING_MANIFEST_FILE } from '@myco-server-worker/core/recovery-staging.js';
import { events, writes } from './recovery-alarm-observer.js';

export class RecoveryProducer extends ProductProducer {
  constructor(ctx: DurableObjectState, env: CloudflareBindings & { TEST_FAIL_MANIFEST?: boolean }) {
    const bucket = env.RECOVERY_BUCKET!;
    const observed = new Proxy(bucket, {
      get(target, property) {
        if (property === 'put') return async (...args: Parameters<typeof bucket.put>) => {
          writes.push(args[0]);
          if (env.TEST_FAIL_MANIFEST && args[0].endsWith(`/${STAGING_MANIFEST_FILE}`)) throw new TypeError('write failed https://secret.invalid/?token=local-fake-token');
          return bucket.put(...args);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, RECOVERY_BUCKET: observed });
  }
}

export class DeploymentClock extends ProductClock {
  override async alarm(): Promise<void> {
    try { await super.alarm(); }
    finally {
      await this.ctx.storage.put('nextWakeAt', await this.ctx.storage.getAlarm());
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put('delivered', (await this.ctx.storage.get<number>('delivered') ?? 0) + 1);
    }
  }

  async delivered(): Promise<number> { return await this.ctx.storage.get<number>('delivered') ?? 0; }
  async nextWakeAt(): Promise<number | null> { return await this.ctx.storage.get<number | null>('nextWakeAt') ?? null; }
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (route === '/test/arm') {
      await clockStub(env.CLOCK!).ensure();
      return Response.json({ armed: true });
    }
    if (route === '/test/status') {
      const server = serverEnvFromBindings(env);
      return Response.json({
        delivered: await (clockStub(env.CLOCK!) as unknown as DeploymentClock).delivered(),
        nextWakeAt: await (clockStub(env.CLOCK!) as unknown as DeploymentClock).nextWakeAt(),
        status: await server.recovery!.status(),
        schedule: await recoveryScheduleOf(server, Number(new URL(request.url).searchParams.get('now') ?? Date.now())),
        events, writes,
      });
    }
    return worker.fetch(request, env, ctx);
  },
};
