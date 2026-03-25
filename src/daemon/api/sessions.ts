import { getSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { listActivitiesByBatch } from '@myco/db/queries/activities.js';
import { listAttachmentsBySession } from '@myco/db/queries/attachments.js';
import type { RouteRequest, RouteResponse } from '../router.js';

export async function handleGetSession(req: RouteRequest): Promise<RouteResponse> {
  const session = getSession(req.params.id);
  if (!session) return { status: 404, body: { error: 'not_found' } };
  return { body: session };
}

export async function handleGetSessionBatches(req: RouteRequest): Promise<RouteResponse> {
  const batches = listBatchesBySession(req.params.id);
  return { body: batches };
}

export async function handleGetBatchActivities(req: RouteRequest): Promise<RouteResponse> {
  const batchId = Number(req.params.id);
  if (isNaN(batchId)) return { status: 400, body: { error: 'invalid_batch_id' } };
  const activities = listActivitiesByBatch(batchId);
  return { body: activities };
}

export async function handleGetSessionAttachments(req: RouteRequest): Promise<RouteResponse> {
  const attachments = listAttachmentsBySession(req.params.id);
  return { body: attachments };
}
