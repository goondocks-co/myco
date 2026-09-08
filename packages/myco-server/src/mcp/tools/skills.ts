/**
 * `myco_skills` over the skills that ship with Myco.
 *
 * The skills are files in the plugin, not rows: they are the same on every
 * Deployment and the same for every principal, so the answer is read from the
 * generated catalogue rather than from storage. `project` is still resolved: a
 * caller naming a Project it cannot reach is refused here as on every other
 * tool, and the tenancy answer does not vary with the shape of the data behind
 * it.
 */
import { SHIPPED_SKILLS, type ShippedSkill } from '@goondocks/myco-shared/skills';
import { failure, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** What a listing carries: enough to choose a skill, never its body. */
const summary = ({ name, description, when_to_use }: ShippedSkill) => ({ name, description, when_to_use });

export async function handleSkills(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  if ((input.op ?? 'list') === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const skill = SHIPPED_SKILLS.find((s) => s.name === id);
    if (skill === undefined) return failure('Skill not found');
    return { ...summary(skill), content: skill.content };
  }
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  const listed = limit === undefined ? SHIPPED_SKILLS : SHIPPED_SKILLS.slice(0, Math.max(0, limit));
  return listed.map(summary);
}
