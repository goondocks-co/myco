import { fixtureFlipEnvelope } from '../../helpers/view-flip-envelope.js';
import type { ServerEnv } from '../../../packages/myco-server/src/core/adapters.js';
import { createEmptyView, requestViewRebuild } from '../../../packages/myco-server/src/ingest/view-lifecycle.js';
import { runViewParseJob } from '../../../packages/myco-server/src/ingest/view-run.js';
import { SERIAL_VIEW_BUDGET } from '../../../packages/myco-server/src/ingest/view-build-queue.js';
import { withViewWriterDriver } from '../../helpers/statement-recorder.js';
import { withObservedViewWriterDriver } from '../observed-worker.js';

/** The isolated parity driver is the only front door that invokes dormant view mutations. */
export async function viewWriterEndpoint(request: Request, env: ServerEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/__view-writer') return null;
  const input = (await request.json()) as { projectId: string; sessionId: string; op: 'empty' | 'rebuild' | 'run' };
  return withViewWriterDriver(() =>
    withObservedViewWriterDriver(async () => {
      const now = Date.now();
      if (input.op === 'empty')
        return Response.json({ instance: await createEmptyView(env.db, input.projectId, input.sessionId, now) });
      if (input.op === 'rebuild')
        return Response.json({ instance: await requestViewRebuild(env.db, input.projectId, input.sessionId, now) });
      if (input.op !== 'run') return Response.json({ error: 'unknown driver operation' }, { status: 400 });
      return Response.json(
        await runViewParseJob(env, now, {
          profile: SERIAL_VIEW_BUDGET,
          envelope: fixtureFlipEnvelope(env.platform.name === 'cloudflare' ? 'D1' : 'native'),
        }),
      );
    }),
  );
}
