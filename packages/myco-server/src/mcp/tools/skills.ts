/**
 * `myco_skills` over the Deployment's skill records. `get` answers the record
 * with its published content; a name resolves as an id does.
 */
import { getPublishedSkillContent, getSkillRecord, listSkillRecords } from '../../core/skills.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export async function handleSkills(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const { db } = ctx.env;
  if ((input.op ?? 'list') === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const record = await getSkillRecord(db, scope, id);
    if (record === null) return failure('Skill not found');
    return { ...snake<Record<string, unknown>>(record), content: await getPublishedSkillContent(db, scope, record.id as string) };
  }
  const records = await listSkillRecords(db, scope, { status: str(input.status), limit: typeof input.limit === 'number' ? input.limit : undefined });
  return records.map((r) => snake(r));
}
