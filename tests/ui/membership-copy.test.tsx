// @vitest-environment jsdom

/**
 * Membership error copy mapping (consolidation Task D-2, review round —
 * copy doctrine): the daemon API's membership error envelopes carry the
 * orchestration's CLI-voiced messages verbatim ("Run `myco detach`…",
 * "…task A2…"). `membershipErrorCopy` maps the stable codes
 * (`host/membership-error.ts`) to outcome copy referencing the Team page's
 * OWN affordances, and falls back to the raw message only for uncoded
 * failures. These tests pin both the mapping and — critically — that the
 * mapped copy never leaks CLI syntax or internal task references.
 */
import { describe, expect, it } from 'bun:test';
import { ApiError } from '../../packages/myco/ui/src/lib/api';
import {
  ATTACH_CONFIRM_COPY,
  CANCEL_MOVE_CONFIRM_COPY,
  DETACH_CONFIRM_COPY,
  DETACH_NO_PULL_CONFIRM_COPY,
  HOST_DETAIL_NO_PROJECTS_COPY,
  HOST_REACHABILITY_COPY,
  LOCAL_GROVE_PICKER_HELPER,
  LOCAL_GROVE_PICKER_LABEL,
  RESIDENCY_STALLED_COPY,
  leaveHostConfirmMessage,
  membershipErrorCode,
  membershipErrorCopy,
  protocolSkewNote,
  reachabilityHintSuffix,
  residencyAbortTooLateCopy,
  residencyPendingDetail,
  residencyPhaseLabel,
  residencyProgressHeadline,
} from '../../packages/myco/ui/src/lib/membership-copy';

function membershipApiError(code: string, message: string): ApiError {
  return new ApiError(400, { error: { code, message } });
}

// The real wire messages the codes travel with — what the copy must REPLACE.
const RAW_MESSAGES: Record<string, string> = {
  project_registered_locally:
    'Cannot attach proj_x: it still has local Grove data (Grove grove_y). Adopting existing local history '
    + 'into a team host requires the residency-transition migration, which is not yet available (task A2). '
    + 'This command attaches a project going forward only — detach/migrate the project off its local Grove first.',
  project_attached_to_other_host:
    'Cannot attach proj_x to host host_a: it is already attached to host host_b (a project may be attached '
    + 'to only one host). Run `myco detach` for this project first if you mean to move it.',
  not_joined:
    'Unknown host host_abc — this machine has no host record for it. Join it first with `myco join host_abc`, then attach.',
  protocol_mismatch:
    'The host rejected enrollment with a protocol-version mismatch (409). This member speaks Team-Host '
    + 'protocol v1; run `myco update` so both sides match, then retry.',
  unknown_local_grove:
    'Unknown local Grove grove_ghost — this machine has no Grove with that id. Pass an existing local '
    + 'Grove id, or omit local_grove_id to use the machine\'s default Grove.',
};

describe('membershipErrorCopy', () => {
  it('maps every known code to outcome copy free of CLI syntax, backticks, and internal task references', () => {
    for (const [code, rawMessage] of Object.entries(RAW_MESSAGES)) {
      const copy = membershipErrorCopy(membershipApiError(code, rawMessage));
      expect(copy).not.toBe(rawMessage);
      expect(copy).not.toContain('`');
      expect(copy).not.toContain('myco ');
      expect(copy).not.toContain('task A2');
      expect(copy).not.toContain('409');
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  it('project_registered_locally copy states the outcome without migration-internals jargon', () => {
    const copy = membershipErrorCopy(membershipApiError('project_registered_locally', RAW_MESSAGES.project_registered_locally));
    expect(copy).toContain('already has local Myco data');
    expect(copy).not.toContain('residency-transition');
  });

  it('not_joined copy points at the join form, not a CLI command', () => {
    const copy = membershipErrorCopy(membershipApiError('not_joined', RAW_MESSAGES.not_joined));
    expect(copy).toContain('form above');
  });

  it('project_attached_to_other_host copy points at the Detach control, not `myco detach`', () => {
    const copy = membershipErrorCopy(membershipApiError('project_attached_to_other_host', RAW_MESSAGES.project_attached_to_other_host));
    expect(copy).toContain('Detach');
  });

  it('unknown_local_grove copy says "Grove" (local Groves are the member\'s own filing system, not team storage) and drops the raw id', () => {
    const copy = membershipErrorCopy(membershipApiError('unknown_local_grove', RAW_MESSAGES.unknown_local_grove));
    expect(copy).toContain('Grove');
    expect(copy).not.toContain('grove_ghost');
  });

  it('maps the enroll-failure codes (T6b) to outcome copy that never echoes the raw HTTP status', () => {
    // The wire messages these codes travel with are already body-sanitized
    // ("Host enrollment failed (HTTP 500).") — the mapped copy must still
    // replace them with user-outcome voice, dropping the raw status/mechanics.
    const rejected = membershipErrorCopy(membershipApiError('host_enroll_rejected', 'Host enrollment failed (HTTP 403).'));
    expect(rejected).not.toContain('HTTP');
    expect(rejected).not.toContain('403');
    expect(rejected.length).toBeGreaterThan(20);

    const failed = membershipErrorCopy(membershipApiError('host_enroll_failed', 'Host enrollment failed (HTTP 500).'));
    expect(failed).not.toContain('HTTP');
    expect(failed).not.toContain('500');
    expect(failed.length).toBeGreaterThan(20);
  });

  it('an unknown code falls back to the raw message rather than hiding it', () => {
    const copy = membershipErrorCopy(membershipApiError('join_failed', 'tailscaled socket did not appear'));
    expect(copy).toContain('tailscaled socket did not appear');
  });

  it('a non-ApiError falls back to err.message; a non-Error stringifies', () => {
    expect(membershipErrorCopy(new Error('plain failure'))).toBe('plain failure');
    expect(membershipErrorCopy('string failure')).toBe('string failure');
  });
});

describe('leaveHostConfirmMessage (host detail slideout + HostCard, Task T5)', () => {
  it('confirms a plain leave — the attached-projects case never reaches this confirm (the control disables)', () => {
    const copy = leaveHostConfirmMessage('Mac Studio');
    expect(copy).toBe('Leave "Mac Studio"? This removes this host\'s address and credential from this machine.');
    expect(copy).not.toContain('Detach');
    expect(copy).not.toContain('detaches');
  });
});

describe('leave refusal copy (leave gating)', () => {
  it('maps leave_projects_attached to UI-affordance copy, dropping the CLI-voiced message', () => {
    const copy = membershipErrorCopy(membershipApiError('leave_projects_attached',
      'Cannot leave host h_x: 2 project(s) are still attached through it. Detach each project first (`myco detach`), then leave.'));
    expect(copy).toContain('Detach each project first');
    expect(copy).not.toContain('myco detach'); // no CLI verbs in browser copy
  });

  it('maps leave_transition_in_flight to host-level copy that offers no cancel control', () => {
    const copy = membershipErrorCopy(membershipApiError('leave_transition_in_flight',
      'Cannot leave host h_x: a project move involving this host is still in progress ("demo"). Wait for it to finish, then leave.'));
    expect(copy).toContain('still moving through this host');
    // Past the detach flip there is no cancel control — the copy must not point at one.
    expect(copy.toLowerCase()).not.toContain('cancel');
    expect(copy).not.toContain('this project'); // host-level surface, not project-voiced
  });
});

describe('Host reachability + protocol-skew copy (host detail slideout, Task T5)', () => {
  it('covers all four display states with distinct, non-empty copy', () => {
    const values = Object.values(HOST_REACHABILITY_COPY);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v.length).toBeGreaterThan(0);
  });

  it('reachabilityHintSuffix renders nothing for uncached, a distinct note for null, and reachable/unreachable for booleans', () => {
    expect(reachabilityHintSuffix(undefined)).toBe('');
    expect(reachabilityHintSuffix(null)).toBe(' — not confirmed');
    expect(reachabilityHintSuffix(true)).toBe(' — reachable');
    expect(reachabilityHintSuffix(false)).toBe(' — unreachable');
  });

  it('protocolSkewNote names the HOST as needing the update for host_older', () => {
    const note = protocolSkewNote('host_older');
    expect(note).toContain('the host needs a Myco update');
  });

  it('protocolSkewNote names THIS machine as needing the update for host_newer', () => {
    const note = protocolSkewNote('host_newer');
    expect(note).toContain("update this machine's Myco");
  });

  it('protocolSkewNote is null for "none" — no note renders', () => {
    expect(protocolSkewNote('none')).toBeNull();
  });
});

describe('Local Grove picker copy (AttachProjectPanel, Task T5, decision-ef693c71 D1)', () => {
  it('label and helper both use "Grove" — the picker names the MEMBER\'s own local Groves (permitted vocabulary)', () => {
    expect(LOCAL_GROVE_PICKER_LABEL.length).toBeGreaterThan(0);
    expect(LOCAL_GROVE_PICKER_HELPER).toContain('Grove');
  });
});

describe('Host detail — empty attached-projects copy (Task T5)', () => {
  it('is non-empty and names "this host"', () => {
    expect(HOST_DETAIL_NO_PROJECTS_COPY).toContain('this host');
  });
});

describe('Residency round-trip copy (Phase F, T5)', () => {
  const RESIDENCY_CODES = [
    'residency_transition_in_flight',
    'residency_requires_host_update',
    'residency_pull_unavailable',
    'residency_detach_needs_root',
    // Returned by residency-abort when the move is past the cancelable phases
    // (detach applying/rehoming, or a finished/absent transition) — the
    // Cancel-move control surfaces it through membershipErrorCopy.
    'residency_abort_too_late',
  ];

  it('maps every residency refusal code to outcome copy free of CLI syntax and mechanism nouns', () => {
    for (const code of RESIDENCY_CODES) {
      const copy = membershipErrorCopy(new ApiError(400, { error: { code, message: 'run `myco detach` — outbox/journal rows pending' } }));
      expect(copy.length).toBeGreaterThan(20);
      expect(copy).not.toContain('`');
      expect(copy).not.toContain('myco ');
      expect(copy.toLowerCase()).not.toContain('outbox');
      expect(copy.toLowerCase()).not.toContain('journal');
    }
  });

  it('residency_detach_needs_root tells the member to reconnect once first', () => {
    const copy = membershipErrorCopy(new ApiError(400, { error: { code: 'residency_detach_needs_root', message: 'no root on record' } }));
    expect(copy).toContain('Reconnect this project once first');
  });

  it('residency_transition_in_flight tells the member a move is already running', () => {
    const copy = membershipErrorCopy(new ApiError(400, { error: { code: 'residency_transition_in_flight', message: 'busy' } }));
    expect(copy).toContain('already in progress');
  });

  it('residency_abort_too_late explains the move will finish on its own', () => {
    const copy = membershipErrorCopy(new ApiError(400, { error: { code: 'residency_abort_too_late', message: 'phase applying' } }));
    expect(copy).toContain('too far along to cancel');
  });

  it('residencyAbortTooLateCopy branches on direction — attach points at Disconnect, detach says let it finish', () => {
    const attach = residencyAbortTooLateCopy('attach');
    expect(attach).toContain('disconnect the project');
    expect(attach).toContain("can't be cancelled");

    const detach = residencyAbortTooLateCopy('detach');
    expect(detach).toContain('already back on this machine');

    // Unknown direction falls back to the direction-agnostic map line.
    expect(residencyAbortTooLateCopy(undefined)).toContain('too far along to cancel');
  });

  it('membershipErrorCode extracts the coded refusal (used by the detach pull-unavailable fallback) and is null for uncoded/non-ApiError', () => {
    expect(membershipErrorCode(new ApiError(400, { error: { code: 'residency_pull_unavailable', message: 'x' } }))).toBe('residency_pull_unavailable');
    expect(membershipErrorCode(new ApiError(400, { message: 'no code here' }))).toBeNull();
    expect(membershipErrorCode(new Error('plain'))).toBeNull();
    expect(membershipErrorCode('nope')).toBeNull();
  });

  it('attach / detach / no-pull / cancel confirmations read in user-outcome voice', () => {
    expect(ATTACH_CONFIRM_COPY).toContain('moves to the team host');
    expect(ATTACH_CONFIRM_COPY).toContain('local backup first');
    expect(DETACH_CONFIRM_COPY).toContain('comes back');
    expect(DETACH_NO_PULL_CONFIRM_COPY).toContain('Disconnect anyway without bringing data back?');
    expect(CANCEL_MOVE_CONFIRM_COPY).toBe('Cancel and put the project back the way it was?');
    for (const s of [ATTACH_CONFIRM_COPY, DETACH_CONFIRM_COPY, DETACH_NO_PULL_CONFIRM_COPY, CANCEL_MOVE_CONFIRM_COPY]) {
      expect(s).not.toContain('`');
      expect(s.toLowerCase()).not.toContain('outbox');
      expect(s.toLowerCase()).not.toContain('journal');
    }
  });

  it('residencyProgressHeadline is direction-aware', () => {
    expect(residencyProgressHeadline('attach')).toBe('Moving history to the team host…');
    expect(residencyProgressHeadline('detach')).toBe('Bringing your data back…');
    // An unknown/absent direction reads as the attach ("moving out") case.
    expect(residencyProgressHeadline(undefined)).toBe('Moving history to the team host…');
  });

  it('residencyPhaseLabel maps every phase to a friendly step, and empty for none', () => {
    expect(residencyPhaseLabel('parking')).toBe('backing up');
    expect(residencyPhaseLabel('pushing')).toBe('moving');
    expect(residencyPhaseLabel('pulling')).toBe('retrieving');
    expect(residencyPhaseLabel('applying')).toBe('restoring');
    expect(residencyPhaseLabel('rehoming')).toBe('finishing');
    expect(residencyPhaseLabel(undefined)).toBe('');
  });

  it('residencyPendingDetail renders a plain "items" count (never "rows"), or null when absent', () => {
    expect(residencyPendingDetail(1)).toBe('1 item left');
    expect(residencyPendingDetail(1234)).toBe('1,234 items left');
    expect(residencyPendingDetail(0)).toBe('0 items left');
    expect(residencyPendingDetail(null)).toBeNull();
    expect(residencyPendingDetail(undefined)).toBeNull();
    expect(residencyPendingDetail(42)).not.toContain('row');
  });

  it('the stalled warning states the outcome + the way out without leaking mechanism', () => {
    expect(RESIDENCY_STALLED_COPY).toContain('Cancel the move');
    expect(RESIDENCY_STALLED_COPY.toLowerCase()).not.toContain('drain');
  });
});
