import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { readCurationAnswer, readCurationCoverage } from '../db/spores/curation-answer.js';
import { notFound, ok, resolveProjectScope } from './scope.js';

export async function handleCurationAnswer(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const row = await readCurationAnswer(env.db, scope.projectId, ctx.params.runId);
  if (row === null) return notFound();
  return ok({ group: row.cluster_key, submissions: row.submissions, applied: row.applied === 1, checked: row.answer === null ? null : JSON.parse(row.answer) });
}

export async function handleCurationCoverage(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  return scope === null ? notFound() : ok(await readCurationCoverage(env.db, scope.projectId));
}
