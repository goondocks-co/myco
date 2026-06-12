/**
 * RC-F — stripPlanTagEnvelopes: plan envelopes never reach persisted
 * response summaries, while the extraction channel (which reads raw parser
 * turns) keeps receiving them. The strip and extraction share one regex
 * (`planTagEnvelopeRegex`) so they can never drift.
 */

import { describe, it, expect } from 'bun:test';
import { stripPlanTagEnvelopes, planTagEnvelopeRegex } from '@myco/plans/tag-envelopes.js';
import { extractTaggedPlans } from '@myco/daemon/plan-capture.js';

const PLAN_BODY = '## Plan\n\n- [x] step one\n- [ ] step two';
const envelope = (body: string = PLAN_BODY) => `<update_plan>\n${body}\n</update_plan>`;

describe('stripPlanTagEnvelopes', () => {
  it('removes every envelope and keeps the surrounding prose', () => {
    const text = `Working on it.\n\n${envelope()}\n\nDone with phase one.\n\n${envelope('## Plan\n\n- [x] all done')}\n\nShip it.`;

    const stripped = stripPlanTagEnvelopes(text, ['update_plan']);

    expect(stripped).not.toContain('<update_plan>');
    expect(stripped).not.toContain('</update_plan>');
    expect(stripped).toContain('Working on it.');
    expect(stripped).toContain('Done with phase one.');
    expect(stripped).toContain('Ship it.');
    expect(stripped).not.toMatch(/\n{3,}/); // no blank-run residue
  });

  it('strips an envelope-only response to the empty string', () => {
    expect(stripPlanTagEnvelopes(envelope(), ['update_plan'])).toBe('');
  });

  it('handles many envelopes (production: 7× in one summary)', () => {
    const text = Array.from({ length: 7 }, (_, i) => envelope(`## Plan\n\n- [ ] rev ${i}`)).join('\n\n');
    expect(stripPlanTagEnvelopes(text, ['update_plan'])).toBe('');
  });

  it('returns envelope-free text unchanged (identity, no re-trim)', () => {
    const text = '  prose with leading whitespace preserved\n\nand a <update_plan tag-lookalike';
    expect(stripPlanTagEnvelopes(text, ['update_plan'])).toBe(text);
  });

  it('only strips the configured tags', () => {
    const text = `<proposed_plan>\nkeep me\n</proposed_plan>\n\n${envelope()}`;
    const stripped = stripPlanTagEnvelopes(text, ['update_plan']);
    expect(stripped).toContain('<proposed_plan>');
    expect(stripped).not.toContain('<update_plan>');
  });

  it('no-ops with an empty tag list', () => {
    const text = envelope();
    expect(stripPlanTagEnvelopes(text, [])).toBe(text);
  });

  it('strip removes exactly what extraction matches (shared regex)', () => {
    const text = `prose before\n\n${envelope()}\n\nprose after`;
    const extracted = extractTaggedPlans(text, ['update_plan']);
    const stripped = stripPlanTagEnvelopes(text, ['update_plan']);

    expect(extracted).toHaveLength(1);
    expect(extracted[0].content).toBe(PLAN_BODY);
    // Everything extraction matched is gone; everything else survives.
    expect(stripped).toBe('prose before\n\nprose after');
    expect(text.match(planTagEnvelopeRegex('update_plan'))).toHaveLength(1);
  });
});
