import { getSession, listSessions, countSessions } from '@myco/db/queries/sessions.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { listActivitiesByBatch } from '@myco/db/queries/activities.js';
import { listAttachmentsBySession } from '@myco/db/queries/attachments.js';
import type { RouteRequest, RouteResponse } from '../router.js';

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_LIST_OFFSET = 0;

export async function handleListSessions(req: RouteRequest): Promise<RouteResponse> {
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const status = req.query.status || undefined;
  const agent = req.query.agent || undefined;
  const search = req.query.search || undefined;

  const filterOpts = { status, agent, search };

  const sessions = listSessions({ ...filterOpts, limit, offset }).map((s) => ({
    id: s.id,
    date: new Date(s.started_at * 1000).toISOString().slice(0, 10),
    title: s.title || s.id.slice(0, 8),
    status: s.status,
    agent: s.agent,
    prompt_count: s.prompt_count,
    tool_count: s.tool_count,
    started_at: s.started_at,
    ended_at: s.ended_at,
  }));
  const total = countSessions(filterOpts);

  return { body: { sessions, total, offset, limit } };
}

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
