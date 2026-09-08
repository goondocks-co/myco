/**
 * The tenancy keys a tool call may carry, and the only place they are spelled.
 *
 * A leaf module with no imports: the tool definitions, the call-context pivot
 * reader and the dispatcher's stripper all need these names, and those three
 * modules already form an import cycle through the write-lease admission gate.
 *
 * Spelling a key by hand is unsafe here in a way it is not elsewhere. Neither
 * validator refuses an argument a schema does not declare — the member's
 * `validateInput` walks the declared properties and skips the rest, and the
 * Deployment's `declaredOnly` drops an undeclared key before any handler sees
 * it. A site that spells the key differently therefore keeps working while
 * doing nothing, and the fault surfaces as a tenancy argument that is silently
 * ignored rather than as an error.
 */

/** The Grove pivot. Retired on the Deployment surface; the local runtime accepts it. */
export const GROVE_PIVOT = 'grove_id';

/** The tenancy key every tool declares: a project id or a git remote. */
export const PROJECT_PIVOT = 'project';

/** Every pivot key, for the dispatcher's stripper. */
export const PIVOT_FIELD_NAMES = [GROVE_PIVOT, PROJECT_PIVOT] as const;
