/**
 * Project write admission for the tool surface (write-admission phase 6).
 *
 * Why this gate has to exist, stated precisely because the obvious answer is
 * wrong: it is NOT that tool calls happen outside the daemon. `myco tool
 * call` is a thin MCP client of the local daemon's `/mcp`
 * (decision-14e572a3), so it runs inside the daemon like everything else.
 *
 * The reason is that **`/mcp` is a RAW route**. `DaemonServer.handleRequest`
 * dispatches raw routes at the top and `return`s, well before the central
 * per-project pause gate that guards ordinary route dispatch
 * (`daemon/server.ts` — raw dispatch vs. the `isWriteMethod` gate further
 * down). So every tool call — CLI, MCP, overlay — reaches the shared
 * handlers having never crossed that gate. A mutating call into a leased
 * project therefore writes into the source Grove during a residency push,
 * where `deleteAfterAck` deletes it unshipped: silent capture loss, from the
 * surface an agent uses most.
 *
 * Reads stay open, matching the HTTP gate's posture: an agent mid-transition
 * can still search, read plans and spores, and pull Cortex context. Only the
 * mutating ops refuse.
 *
 * Known gap, deliberately not solved here: a refused write is NOT buffered.
 * The capture path survives the same condition because the hook writes its
 * event to a local buffer on any non-2xx and a drain replays it; the tool
 * path has no equivalent, so refused agent-authored content lives only in
 * the caller's context. Hence `retryable` on the error and copy that tells
 * the caller to keep the content — the durable fix is a follow-up.
 */

import { isProjectPaused, type ProjectPauseStatus } from '@myco/grove/registry.js';
import { RESIDENCY_ATTACH_OP, RESIDENCY_DETACH_OP } from '@myco/host/residency-transition.js';
import { ToolError } from './error.js';
import { effectiveOp } from './op-resolution.js';
import {
  TOOL_AGENT,
  TOOL_CORTEX,
  TOOL_PLANS,
  TOOL_SEARCH,
  TOOL_SESSIONS,
  TOOL_SKILLS,
  TOOL_SPORES,
} from './definitions.js';

/**
 * Every (tool, op) pair, classified by whether it mutates project state.
 *
 * Per-(tool, op) rather than per-tool `readOnlyHint`, because `myco_plans`
 * and `myco_spores` are marked write-capable as a whole while most of their
 * ops are reads — keying off the tool would blind an agent to its own plans
 * and spores for the length of a transition, buying no safety.
 *
 * Deliberately NOT reusing `EXTERNAL_TOOL_ALLOWLIST`: that answers a
 * different question ("what may a non-member outsider reach"), which is why
 * it excludes reads like `myco_cortex maintenance_summary` on
 * confidentiality grounds. Borrowing it here would refuse reads that are
 * perfectly safe mid-transition.
 *
 * `null` marks a tool with no `op` concept — the whole tool is one class.
 * A completeness gate (`tests/meta/tool-op-classification.test.ts`) asserts
 * this table covers every op in every tool's schema enum, so a newly added
 * op cannot appear unclassified.
 */
export const TOOL_OP_CLASSIFICATION: Record<string, { read: readonly string[]; write: readonly string[] } | null> = {
  [TOOL_SEARCH]: null,
  [TOOL_CORTEX]: {
    read: ['digest', 'instructions', 'canopy_map', 'canopy_entry', 'notifications', 'maintenance_summary', 'projects_activity'],
    write: [],
  },
  // `get` is a read HERE, but it is not write-free: retrieving a plan from a
  // session other than its creator records a PLAN_REFERENCED lineage edge
  // into `graph_edges`, which IS project-scoped. Classifying it `write` would
  // blind the `myco-handoff receive` flow for the length of a transition,
  // which is the flow that most needs to read plans — so the edge is gated at
  // its own write site instead (`db/queries/lineage.ts`
  // `recordPlanSessionTouch`), where the project actually being written is
  // known. "read" in this table means "admitted by THIS gate", not "performs
  // no write anywhere".
  [TOOL_PLANS]: { read: ['list', 'get'], write: ['save', 'delete'] },
  [TOOL_SESSIONS]: { read: ['list', 'get'], write: [] },
  [TOOL_SKILLS]: { read: ['list', 'get'], write: [] },
  [TOOL_SPORES]: {
    read: ['list', 'get'],
    write: ['save', 'supersede', 'consolidate', 'obsolete'],
  },
  [TOOL_AGENT]: { read: ['runs', 'run'], write: [] },
};

/**
 * True when this call mutates project state and must therefore consult
 * admission.
 *
 * Fails CLOSED in both unknown directions: an unrecognised tool, and an op
 * absent from its tool's classification, are both treated as writes. A new
 * op that someone forgets to classify is refused during a transition rather
 * than admitted through it — the conservative side, and the completeness
 * gate turns the omission into a build failure anyway.
 */
export function isMutatingToolCall(toolName: string, args: unknown): boolean {
  const entry = TOOL_OP_CLASSIFICATION[toolName];
  if (entry === undefined) return true;
  if (entry === null) return false;
  const op = effectiveOp(toolName, args);
  if (entry.read.includes(op)) return false;
  return true;
}

/**
 * User-vocabulary phrase for the operation holding the lease.
 *
 * EXACT match against the two residency constants, never a substring,
 * because the producers disagree about which field carries what:
 *
 *   - residency (`acquireProjectLease(projectId, ownerOp, reason, …)`) puts
 *     `residency-attach` / `residency-detach` in `owner_op`;
 *   - `grove move` (`pauseProject(groveId, projectId, reason, ownerOp, …)` —
 *     note reason BEFORE ownerOp) puts the literal `grove-move` in `reason`
 *     and an OPAQUE generated id, `grove-move-<projectId>-<epoch>`, in
 *     `owner_op`.
 *
 * So `owner_op` is a stable constant for one producer and a generated id for
 * the other. Substring-matching it would be matching against that id, and
 * only avoids a false "attach"/"detach" hit by the accident that hex project
 * ids contain no 't' or 'h'. Exact-matching the constants makes a move fall
 * through to the generic phrase by construction instead — which is the right
 * answer for it anyway, so `reason` never needs consulting. Anything
 * unrecognised gets the generic phrasing rather than leaking a mechanism
 * name into agent-facing text.
 */
function movePhrase(ownerOp: string): string {
  if (ownerOp === RESIDENCY_ATTACH_OP) return 'joining a team';
  if (ownerOp === RESIDENCY_DETACH_OP) return 'leaving a team';
  return 'being moved';
}

/**
 * The refusal an agent sees.
 *
 * Three things it has to do, in order: state the outcome, confirm the write
 * did NOT happen (so a caller retries instead of assuming success), and say
 * whether retrying is worth it. It names the project because the pivot case
 * refuses a project that is by definition NOT the one the agent is working
 * in — "this project" would be ambiguous exactly where it matters.
 *
 * `ownerOp === null` means the lease record could not be read, which is a
 * genuinely different situation and must not borrow the in-progress copy:
 * no move may be running at all, so "try again once the move finishes"
 * would promise a resolution that never comes and send an agent into a
 * blind retry loop against a permanent failure. That branch says plainly
 * that someone has to look at it.
 */
export function leaseRefusalMessage(projectId: string, ownerOp: string | null): string {
  if (ownerOp === null) {
    return `Project ${projectId} can't be changed: its move-in-progress record is unreadable, `
      + 'so Myco is refusing changes to protect the project. Nothing was saved, and retrying '
      + "won't clear this on its own — it needs someone to look at it.";
  }
  return `Project ${projectId} is ${movePhrase(ownerOp)} right now, so it can't be changed yet. `
    + 'Nothing was saved — keep this content and save it again once the move finishes.';
}

/**
 * Refuse a mutating call into a project whose write lease is held.
 *
 * An unreadable lease record counts as held (Write Admission G4): a torn
 * read keeps the writer out rather than opening the gate. The owner is
 * unknown in that case, so the message uses the generic phrasing.
 */
export function assertProjectAdmitsToolWrite(projectId: string, mycoHome: string): void {
  // `isProjectPaused`, NOT `readProjectLease`, so this matches what every
  // other writer-side gate consults (`daemon/server.ts`, `agent/executor.ts`,
  // `daemon/api/scoped-dispatch.ts`). It is the lease UNION the legacy in-row
  // `projects.toml` pause that the previous binary wrote; a project paused
  // that way has no lease file at all, so reading the lease alone would admit
  // a write that the HTTP gate refuses — during exactly the upgrade window
  // the fallback exists for. It also throws on an unreadable record (G4), and
  // collapses a released lease to not-paused.
  let status: ProjectPauseStatus;
  try {
    status = isProjectPaused(projectId, mycoHome);
  } catch {
    // Unreadable: refuse, and say so honestly — this does not self-clear.
    throw new ToolError(
      'project_lease_held',
      leaseRefusalMessage(projectId, null),
      { retryable: false },
    );
  }
  if (!status.paused) return;
  // A held lease clears when the move ends, so retrying is worthwhile.
  throw new ToolError(
    'project_lease_held',
    leaseRefusalMessage(projectId, status.owner_op),
    { retryable: true },
  );
}
