/**
 * `myco_skills` over the skills that ship with Myco.
 *
 * The skills are files in the plugin, not rows: they are the same on every
 * Deployment and the same for every principal, so the answer is read from the
 * generated catalogue rather than from storage. `project` is still resolved: a
 * caller naming a Project it cannot reach is refused here as on every other
 * tool, and the tenancy answer does not vary with the shape of the data behind
 * it.
 *
 * The catalogue carries listing text and no bodies. This module is bundled into
 * the Worker script, whose size ceiling is a free-tier tripwire, and nine
 * bodies are 57 KiB that grows with every skill added. A body is served by the
 * plugin that installed it, on the disk of every client able to call this.
 */
import { SHIPPED_SKILLS } from '@goondocks/myco-shared/skills';
import { failure, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** The refusal a `status` filter meets: the Deployment serves files, and a file has no status. */
export const NO_STATUS_MESSAGE = 'This deployment serves the skills that ship with Myco, which have no status; drop the status filter.';

/** Where a shipped skill's body lives, for a caller that wants to read one. */
const shipsWith = (name: string): string => `plugin: skills/${name}/SKILL.md`;

export async function handleSkills(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  // A shipped skill has no status. Accepting the filter and answering the whole
  // catalogue would look like a filter that matched everything, which is the
  // silent no-op an argument the handler does not honour always becomes.
  if (input.status !== undefined) return failure(NO_STATUS_MESSAGE);
  if ((input.op ?? 'list') === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const skill = SHIPPED_SKILLS.find((s) => s.name === id);
    if (skill === undefined) return failure('Skill not found');
    return { ...skill, ships_with: shipsWith(skill.name) };
  }
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  const listed = limit === undefined ? SHIPPED_SKILLS : SHIPPED_SKILLS.slice(0, Math.max(0, limit));
  return listed.map((skill) => ({ ...skill }));
}
