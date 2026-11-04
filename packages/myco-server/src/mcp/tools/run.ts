/**
 * `myco_run`: the record one run keeps of itself.
 *
 * The report is the run's claim about its own pass, and the close gate reads it
 * (`core/run-postconditions.ts`). Its agent comes off the principal, never off
 * the arguments, so a run cannot file a report under another agent's name. A
 * report carries its audit (`core/run-audit.ts`); one whose audit is refused is
 * still recorded, and is answered as a failure that says what the audit lacks:
 * the run it belongs to cannot close as completed on it. An audit the server
 * repaired is recorded and answered with the repairs made.
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
import { isServerStateKey } from '../../core/scheduler-state.js';
import { getState, mutateState } from '../../core/runs.js';
import { MAX_REPORT_DETAILS_CHARS as MAX_DETAILS_CHARS, MAX_REPORT_SUMMARY_CHARS as MAX_SUMMARY_CHARS, recordReport } from '../../core/run-postconditions.js';
import { RUN_AUDIT_SHAPE } from '../../core/run-audit.js';
import { RUN_ANSWER_BYTES } from '../../core/read-window.js';
import { answerBytes, headThatFits } from '../../core/material-pages.js';
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const MAX_ACTION_CHARS = 192;
const MAX_KEY_CHARS = 192;
/** How much of the digest the token carries. */
const VERSION_CHARS = 16;
/** The refusal of a continuation whose value has moved past the version its earlier parts came from: read again from offset 0. */
export const STATE_CHANGED = 'state_changed';
/** The room a value cut to fit one answer keeps for the rest of that answer's fields. */
const STATE_ANSWER_FIELDS_BYTES = 512;
/** What `state_get` answers for a value: bounded by what one answer may carry, and never so long that its version is withheld. */
const stateAnswer = (key: string, value: string | null, updatedAt: number | null, version: string | undefined) =>
  ({ key, value, updated_at: updatedAt, ...(version === undefined ? {} : { version }) });
const stateWeight = (key: string, value: string) => answerBytes({ result: stateAnswer(key, value, Number.MAX_SAFE_INTEGER, '0'.repeat(VERSION_CHARS)) });

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
    const recorded = await recordReport(db, scope, { runId: run.runId, agentId: run.agentId, action, summary, details, audit: input.audit, createdAt: ctx.now });
    if (!recorded.recorded) return failure(recorded.reason === 'unaccepted' ? recorded.error : 'this run is not one this Project holds');
    if (recorded.auditError !== null) {
      return failure(`the report was recorded without its audit (${recorded.auditError}), so this run cannot close as completed; report again with the audit: ${RUN_AUDIT_SHAPE}`);
    }
    return { recorded: true, action, ...(recorded.auditRepairs.length === 0 ? {} : { audit_repaired: recorded.auditRepairs }) };
  }

  const key = str(input.key, MAX_KEY_CHARS);
  if (key === undefined) return failure(`key is required for op: ${String(op)}`);

  if (op === 'state_get') {
    const row = await getState(db, scope, run.agentId, key);
    const value = row?.value ?? null;
    const version = await versionOf(value);
    const updatedAt = row?.updatedAt ?? null;
    const offset = input.offset === undefined ? 0 : input.offset as number;
    if (!Number.isSafeInteger(offset) || offset < 0) return failure('offset is a whole number from 0');
    if (offset > 0 && input.version !== version) {
      return { ...failure('the value changed since offset 0, or this call carries no version from it: restart at offset 0'), code: STATE_CHANGED };
    }
    if (value === null) return stateAnswer(key, null, updatedAt, version);
    const rest = value.slice(offset);
    if (stateWeight(key, rest) <= RUN_ANSWER_BYTES) return stateAnswer(key, rest, updatedAt, version);
    const head = headThatFits(rest, RUN_ANSWER_BYTES - STATE_ANSWER_FIELDS_BYTES, (candidate) => stateWeight(key, candidate));
    return { ...stateAnswer(key, head, updatedAt, version), next_offset: offset + head.length };
  }

  if (isServerStateKey(key)) return failure('server control state is read-only');
  const value = str(input.value, RUN_ANSWER_BYTES);
  if (value === undefined || stateWeight(key, value) > RUN_ANSWER_BYTES) return failure(`value is required for op: state_set, and must fit one ${RUN_ANSWER_BYTES}-byte answer as JSON`);
  const named = input.version === undefined ? undefined : str(input.version, VERSION_CHARS);
  if (input.version !== undefined && named === undefined) return failure('version is the token state_get answered');

  const row = await getState(db, scope, run.agentId, key);
  const current = row?.value ?? null;
  if ((await versionOf(current)) !== named) return { key, applied: false };

  let matched = false;
  const settled = await mutateState(db, scope, run.agentId, key, (live) => {
    matched = live === current;
    return matched ? value : null;
  }, ctx.now);
  // `mutateState` answers false when every attempt lost the guard, which is
  // contention rather than a landed write; the caller reads again either way.
  return { key, applied: matched && settled };
}
