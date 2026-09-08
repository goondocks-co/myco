/**
 * `myco_run`: the record one run keeps of itself.
 *
 * The report is the run's claim about its own pass, and the close gate reads it
 * (`core/run-postconditions.ts`). Its agent comes off the principal, never off
 * the arguments, so a run cannot file a report under another agent's name.
 *
 * State is a compare-and-set. `state_get` answers a version token — a digest of
 * the value it read — and `state_set` presents it back. The token is what
 * crosses the wire; the guard the write actually runs under is still the whole
 * value, inside `mutateState`. A digest cannot be taken inside that callback,
 * which is synchronous, so this reads the row, digests what it read, and passes
 * the value it read as the guard. Two values sharing a token is possible and
 * bounded by the token's width; what such a collision costs is one write
 * admitted against a value the caller did not read, never a lost write.
 */
import { sha256Hex } from '../../hash.js';
import { getState, insertReport, mutateState } from '../../core/runs.js';
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const MAX_ACTION_CHARS = 192;
const MAX_SUMMARY_CHARS = 4_096;
const MAX_DETAILS_CHARS = 65_536;
const MAX_KEY_CHARS = 192;
/** The largest state value this surface accepts, bounding one row against a caller that would grow it without limit. */
export const MAX_STATE_VALUE_CHARS = 256 * 1024;
/** How much of the digest the token carries. */
const VERSION_CHARS = 16;

const str = (v: unknown, max: number): string | undefined =>
  (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** The token that names a value's content, or undefined for a key that holds none. */
export async function versionOf(value: string | null): Promise<string | undefined> {
  return value === null ? undefined : (await sha256Hex(value)).slice(0, VERSION_CHARS);
}

export async function handleRun(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run');
  const scope = { projectId: ctx.projectId };
  const { db } = ctx.env;
  const op = input.op;

  if (op === 'report') {
    const action = str(input.action, MAX_ACTION_CHARS);
    const summary = str(input.summary, MAX_SUMMARY_CHARS);
    if (action === undefined || summary === undefined) return failure('action and summary are required for op: report');
    const details = input.details === undefined || input.details === null ? null : str(input.details, MAX_DETAILS_CHARS);
    if (details === undefined) return failure(`details is at most ${MAX_DETAILS_CHARS} characters`);
    const recorded = await insertReport(db, scope, {
      runId: run.runId, agentId: run.agentId, action, summary, details, createdAt: ctx.now,
    });
    if (!recorded) return failure('this run is not one this Project holds');
    return { recorded: true, action };
  }

  const key = str(input.key, MAX_KEY_CHARS);
  if (key === undefined) return failure(`key is required for op: ${String(op)}`);

  if (op === 'state_get') {
    const row = await getState(db, scope, run.agentId, key);
    const value = row?.value ?? null;
    const version = await versionOf(value);
    return { key, value, updated_at: row?.updatedAt ?? null, ...(version === undefined ? {} : { version }) };
  }

  const value = str(input.value, MAX_STATE_VALUE_CHARS);
  if (value === undefined) return failure(`value is required for op: state_set, and is at most ${MAX_STATE_VALUE_CHARS} characters`);
  const named = input.version === undefined ? undefined : str(input.version, VERSION_CHARS);
  if (input.version !== undefined && named === undefined) return failure('version is the token state_get answered');

  const row = await getState(db, scope, run.agentId, key);
  const current = row?.value ?? null;
  if ((await versionOf(current)) !== named) return { key, applied: false };

  let applied = false;
  await mutateState(db, scope, run.agentId, key, (live) => {
    applied = live === current;
    return applied ? value : null;
  }, ctx.now);
  return { key, applied };
}
