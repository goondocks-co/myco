/**
 * `myco_skills` over the skills that ship with Myco.
 *
 * The skills are files, not rows: they are the same on every Deployment and the
 * same for every principal, so the answer is read from the generated catalogue
 * rather than from storage. `project` is still resolved: a caller naming a
 * Project it cannot reach is refused here as on every other tool, and the
 * tenancy answer does not vary with the shape of the data behind it.
 *
 * The catalogue carries listing text and no bodies. This module is bundled into
 * the Worker script, whose size ceiling is a free-tier tripwire, and nine bodies
 * are 57 KiB that grows with every skill added.
 *
 * Where a body can be read differs by principal, so `get` answers differently
 * for each rather than naming one path that is wrong for the other. A machine
 * running the binary holds every body under its Myco home, written there from
 * the binary's own bundle whether or not any plugin is installed. An access key
 * is held by an agent with neither, so for it the body is not served at all and
 * saying so is the honest answer.
 */
import { SHIPPED_SKILLS } from '@goondocks/myco-shared/skills';
import { failure, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** The refusal a `status` filter meets: the Deployment serves files, and a file has no status. */
export const NO_STATUS_MESSAGE = 'This deployment serves the skills that ship with Myco, which have no status; drop the status filter.';

/** What an access key is told when it asks for a body it has no copy of. */
export const NO_BODY_FOR_GRANT = 'Skill bodies are not served to an access key: they ship on disk with the Myco binary or plugin, which this caller has neither of.';

/** Where a machine running the binary holds a skill's body, written there by the binary's own bundle. */
export const skillBodyLocation = (name: string): string => `<myco-home>/skills/${name}/SKILL.md`;

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
    if (ctx.principal.kind === 'grant') return { ...skill, body: NO_BODY_FOR_GRANT };
    return { ...skill, body_at: skillBodyLocation(skill.name) };
  }
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  return limit === undefined ? SHIPPED_SKILLS : SHIPPED_SKILLS.slice(0, Math.max(0, limit));
}
