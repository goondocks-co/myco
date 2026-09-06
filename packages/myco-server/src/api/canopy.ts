import { MAP_TASK, MapArtifactError, parseMapSourcePin } from '@goondocks/myco-shared/canopy';
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext, RouteContext } from '../context.js';
import { readCanopyMap } from '../read/canopy.js';
import { readMapSettings, writeCanopyMap } from '../core/canopy.js';
import { mapSourcePinOfRun, pinMapSourceForRun, repositoryPinOfRun } from '../core/runs.js';
import { heldRun } from './run-admission.js';
import { notFound, ok, parseJsonObject, resolveProjectScope } from './scope.js';
import { refused } from '../ingest/events.js';
import { refusal } from '../telemetry.js';

export async function handleProjectMap(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  return scope === null ? notFound() : ok({ map: await readCanopyMap(env.db, scope) });
}

/** Preparation, source pinning and publication share one held-map-run admission. */
export async function handleRunMap(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseJsonObject(ctx.body);
  if (body === null || typeof body.runId !== 'string' || !body.runId || body.runId.length > 192) {
    return Response.json(refused(ctx, refusal('runId is required', 'parse')));
  }
  const run = await heldRun(env, ctx, body.runId, [MAP_TASK]);
  if (run === null) return ok({ persisted: true, held: false });
  const scope = { projectId: ctx.projectId };
  try {
    if (body.op === 'prepare') {
      return ok({ persisted: true, held: true, map: await readCanopyMap(env.db, scope), settings: await readMapSettings(env.db),
        source: mapSourcePinOfRun(run), fresh: JSON.parse(run.runContext ?? '{}').fresh === true });
    }
    if (body.op === 'pin') {
      const source = parseMapSourcePin(body.source);
      if (repositoryPinOfRun(run) === null) throw new MapArtifactError('Prepare committed source before pinning map input.');
      const current = await readCanopyMap(env.db, scope);
      if ((current?.revision ?? null) !== source.priorRevision && !(current?.sourceRunId === run.id && current.inputHash === source.inputHash)) {
        throw new MapArtifactError('The current map changed. Start a new run.');
      }
      const pinned = await pinMapSourceForRun(env.db, scope, run, source);
      return ok({ persisted: true, held: pinned !== null, source: pinned });
    }
    if (body.op === 'write') {
      return ok({ persisted: true, held: true, dryRun: run.dryRun === 1,
        written: await writeCanopyMap(env.db, scope, run, body.artifact, ctx.now) });
    }
    throw new MapArtifactError('Unknown map operation.');
  } catch (error) {
    if (error instanceof MapArtifactError) return Response.json(refused(ctx, refusal(error.message, 'parse')));
    throw error;
  }
}
