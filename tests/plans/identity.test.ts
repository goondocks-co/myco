/**
 * Anti-drift tests for plan logical-key builders.
 *
 * The MCP `myco_save_plan` tool and the transcript-tag capture path both
 * compose session-scoped logical keys, but they MUST land in distinct
 * namespaces so an agent that drops a `<primary>` tag *and* calls
 * myco_save_plan({plan_key: 'primary'}) produces two rows, not one.
 *
 * Finding #10 of the pre-0.21 runtime review.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSessionPlanLogicalKey,
  buildSessionTagPlanLogicalKey,
  buildPathPlanLogicalKey,
} from '@myco/plans/identity.js';

describe('plan logical-key namespaces', () => {
  it('session tag capture and session plan_key use different namespaces', () => {
    const sessionId = 'sess-001';
    const name = 'primary';

    const fromTag = buildSessionTagPlanLogicalKey(sessionId, name);
    const fromKey = buildSessionPlanLogicalKey(sessionId, name);

    expect(fromTag).not.toBe(fromKey);
    expect(fromTag).toBe('session:sess-001:tag:primary');
    expect(fromKey).toBe('session:sess-001:key:primary');
  });

  it('session-scoped keys (tag or key) never collide with path-scoped keys', () => {
    const sessionId = 'sess-002';
    expect(buildSessionPlanLogicalKey(sessionId, 'plan.md'))
      .not.toBe(buildPathPlanLogicalKey('plan.md'));
    expect(buildSessionTagPlanLogicalKey(sessionId, 'plan.md'))
      .not.toBe(buildPathPlanLogicalKey('plan.md'));
  });

  it('distinct sessions produce distinct keys for the same tag/name', () => {
    expect(buildSessionTagPlanLogicalKey('sess-a', 'primary'))
      .not.toBe(buildSessionTagPlanLogicalKey('sess-b', 'primary'));
    expect(buildSessionPlanLogicalKey('sess-a', 'primary'))
      .not.toBe(buildSessionPlanLogicalKey('sess-b', 'primary'));
  });
});
