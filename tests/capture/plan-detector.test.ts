import { describe, it, expect } from 'vitest';
import { PlanDetector, type PlanSignal } from '@myco/capture/plan-detector';

describe('PlanDetector', () => {
  it('detects plan mode hook signal', () => {
    const detector = new PlanDetector();
    const signals = detector.detect({
      hookEvents: [{ type: 'EnterPlanMode', timestamp: '2026-03-12T09:00:00Z' }],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('hook');
    expect(signals[0].confidence).toBe('high');
  });

  it('detects artifact file creation signal', () => {
    const detector = new PlanDetector();
    const signals = detector.detect({
      newFiles: ['docs/superpowers/specs/2026-03-12-myco-design.md'],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('artifact');
  });

  it('returns no signals for routine activity', () => {
    const detector = new PlanDetector();
    const signals = detector.detect({
      hookEvents: [],
      newFiles: ['src/utils/helper.ts'],
    });
    expect(signals).toEqual([]);
  });

  it('detects .claude/plans/ artifacts', () => {
    const detector = new PlanDetector();
    const signals = detector.detect({
      newFiles: ['.claude/plans/auth-redesign.md'],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('artifact');
  });
});
