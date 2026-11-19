import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { CURATION_CLUSTER_CAP } from '../core/spore-curation-contract.js';
import { readCurationAnswer, readCurationCoverage, type CheckedCuration } from '../db/spores/curation-answer.js';
import { sporesWithSourceById } from '../db/spores/records.js';
import { notFound, ok, resolveProjectScope } from './scope.js';

/** One group member as the run was offered it, and as it reads now; `current` is null once the Project no longer holds it. */
export interface CurationSource {
  id: string;
  revision: number;
  current: { revision: number; status: string; observationType: string; agentLine: string | null; content: string } | null;
}

/** A curation run's checked answer, with the current text of its group's members only: at most one group's notes. */
export async function handleCurationAnswer(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const row = await readCurationAnswer(env.db, scope.projectId, ctx.params.runId);
  if (row === null) return notFound();
  const checked = row.answer === null ? null : JSON.parse(row.answer) as CheckedCuration;
  const members = checked?.members.slice(0, CURATION_CLUSTER_CAP) ?? [];
  const held = await sporesWithSourceById(env.db, scope, members.map(member => member.id));
  const sources: CurationSource[] = members.map(({ id, revision }) => {
    const spore = held.get(id);
    return { id, revision, current: spore === undefined ? null
      : { revision: spore.revision, status: spore.status, observationType: spore.observationType, agentLine: spore.agentLine, content: spore.content } };
  });
  return ok({ group: row.cluster_key, submissions: row.submissions, applied: row.applied === 1, checked, sources });
}

export async function handleCurationCoverage(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  return scope === null ? notFound() : ok(await readCurationCoverage(env.db, scope.projectId));
}
