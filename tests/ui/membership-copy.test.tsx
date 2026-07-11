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
import { membershipErrorCopy } from '../../packages/myco/ui/src/lib/membership-copy';

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

  it('an unknown code falls back to the raw message rather than hiding it', () => {
    const copy = membershipErrorCopy(membershipApiError('join_failed', 'tailscaled socket did not appear'));
    expect(copy).toContain('tailscaled socket did not appear');
  });

  it('a non-ApiError falls back to err.message; a non-Error stringifies', () => {
    expect(membershipErrorCopy(new Error('plain failure'))).toBe('plain failure');
    expect(membershipErrorCopy('string failure')).toBe('string failure');
  });
});
