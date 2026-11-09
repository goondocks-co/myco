import {
  runRefusal,
  REPORT_NEXT,
  RUN_ACTION_MAX_CHARS as MAX_ACTION_CHARS,
  RUN_KEY_MAX_CHARS as MAX_KEY_CHARS,
  RUN_VERSION_CHARS as VERSION_CHARS,
} from '../../core/run-tool-contract.js';
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
import { getState, mutateState } from '../../db/runs/state.js';
import {
  MAX_REPORT_DETAILS_CHARS as MAX_DETAILS_CHARS,
  MAX_REPORT_SUMMARY_CHARS as MAX_SUMMARY_CHARS,
  recordReport,
} from '../../core/run-postconditions.js';
import { RUN_AUDIT_SHAPE } from '../../core/run-audit.js';
import { RUN_ANSWER_BYTES } from '../../core/read-window.js';
import { answerBytes, headThatFits } from '../../core/material-pages.js';
import { runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

/** How much of the digest the token carries. */

/** The refusal of a continuation whose value has moved past the version its earlier parts came from: read again from offset 0. */
export const STATE_CHANGED = 'state_changed';
/** The room a value cut to fit one answer keeps for the rest of that answer's fields. */
const STATE_ANSWER_FIELDS_BYTES = 512;
/** What `state_get` answers for a value: bounded by what one answer may carry, and never so long that its version is withheld. */
const stateAnswer = (key: string, value: string | null, updatedAt: number | null, version: string | undefined) => ({
  key,
  value,
  updated_at: updatedAt,
  ...(version === undefined ? {} : { version }),
});
const stateWeight = (key: string, value: string) =>
  answerBytes({ result: stateAnswer(key, value, Number.MAX_SAFE_INTEGER, '0'.repeat(VERSION_CHARS)) });

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

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
    if (action === undefined || summary === undefined)
      return runRefusal({
        what: 'report',
        actual: `action is ${typeof input.action === 'string' ? input.action.length : 'missing or not text'} characters (1–${MAX_ACTION_CHARS}); summary is ${typeof input.summary === 'string' ? input.summary.length : 'missing or not text'} characters (1–${MAX_SUMMARY_CHARS})`,
        next: REPORT_NEXT,
        repair: 'Supply action and summary within these limits.',
      });
    const details = input.details === undefined || input.details === null ? null : str(input.details, MAX_DETAILS_CHARS);
    if (details === undefined)
      return runRefusal({
        what: 'report',
        actual: `details is ${typeof input.details === 'string' ? input.details.length : 'not text'} characters; the limit is ${MAX_DETAILS_CHARS}`,
        next: REPORT_NEXT,
        repair: 'Shorten details or omit it.',
      });
    const recorded = await recordReport(db, scope, {
      runId: run.runId,
      agentId: run.agentId,
      action,
      summary,
      details,
      audit: input.audit,
      createdAt: ctx.now,
    });
    if (!recorded.recorded)
      return runRefusal({
        what: 'report',
        actual:
          recorded.reason === 'unaccepted'
            ? `action is ${JSON.stringify(input.action)}; ${recorded.error}`
            : 'this run is not one this Project holds',
        next: REPORT_NEXT,
      });
    if (recorded.auditError !== null) {
      return runRefusal({
        what: 'report audit (the report was recorded without its audit)',
        actual: recorded.auditError,
        next: REPORT_NEXT,
        repair: `Supply the corrected audit: ${RUN_AUDIT_SHAPE}.`,
      });
    }
    return { recorded: true, action, ...(recorded.auditRepairs.length === 0 ? {} : { audit_repaired: recorded.auditRepairs }) };
  }

  const key = str(input.key, MAX_KEY_CHARS);
  if (key === undefined)
    return runRefusal({
      what: 'run state',
      read: input.op === 'state_get',
      actual: `key is ${typeof input.key === 'string' ? input.key.length : 'missing or not text'} characters; expected 1–${MAX_KEY_CHARS}`,
      next: { tool: 'myco_run', op: 'state_get' },
      repair: 'Supply key.',
    });

  if (op === 'state_get') {
    const row = await getState(db, scope, run.agentId, key);
    const value = row?.value ?? null;
    const version = await versionOf(value);
    const updatedAt = row?.updatedAt ?? null;
    const offset = input.offset === undefined ? 0 : (input.offset as number);
    if (!Number.isSafeInteger(offset) || offset < 0)
      return runRefusal({
        what: 'state read',
        read: true,
        actual: `offset is ${JSON.stringify(offset)}; expected a whole number from 0`,
        next: { tool: 'myco_run', op: 'state_get', key, offset: 0 },
      });
    if (offset > 0 && input.version !== version) {
      return {
        ...runRefusal({
          what: 'state read',
          read: true,
          actual: 'the value changed since offset 0, or version is missing',
          next: { tool: 'myco_run', op: 'state_get', key, offset: 0 },
        }),
        code: STATE_CHANGED,
      };
    }
    if (value === null) return stateAnswer(key, null, updatedAt, version);
    const rest = value.slice(offset);
    if (stateWeight(key, rest) <= RUN_ANSWER_BYTES) return stateAnswer(key, rest, updatedAt, version);
    const head = headThatFits(rest, RUN_ANSWER_BYTES - STATE_ANSWER_FIELDS_BYTES, (candidate) => stateWeight(key, candidate));
    return { ...stateAnswer(key, head, updatedAt, version), next_offset: offset + head.length };
  }

  if (isServerStateKey(key))
    return runRefusal({ what: 'state write', actual: `server control key ${JSON.stringify(key)} is read-only`, next: REPORT_NEXT });
  const value = str(input.value, RUN_ANSWER_BYTES);
  if (value === undefined || stateWeight(key, value) > RUN_ANSWER_BYTES)
    return runRefusal({
      what: 'state write',
      actual: `value weighs ${typeof input.value === 'string' ? stateWeight(key, input.value) : 'missing or not text'} JSON UTF-8 bytes; the limit is ${RUN_ANSWER_BYTES}`,
      next: { tool: 'myco_run', op: 'state_set', key },
      repair: 'Supply a nonempty value within the answer limit and the version from state_get.',
    });
  const named = input.version === undefined ? undefined : str(input.version, VERSION_CHARS);
  if (input.version !== undefined && named === undefined)
    return runRefusal({
      what: 'state write',
      actual: `version is ${typeof input.version === 'string' ? input.version.length : 'not text'} characters; expected the ${VERSION_CHARS}-character token state_get answered`,
      next: { tool: 'myco_run', op: 'state_get', key },
    });

  const row = await getState(db, scope, run.agentId, key);
  const current = row?.value ?? null;
  if ((await versionOf(current)) !== named) return { key, applied: false };

  let matched = false;
  const settled = await mutateState(
    db,
    scope,
    run.agentId,
    key,
    (live) => {
      matched = live === current;
      return matched ? value : null;
    },
    ctx.now,
  );
  // `mutateState` answers false when every attempt lost the guard, which is
  // contention rather than a landed write; the caller reads again either way.
  return { key, applied: matched && settled };
}
