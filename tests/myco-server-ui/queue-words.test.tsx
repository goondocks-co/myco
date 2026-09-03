import { describe, expect, it } from 'bun:test';
import { queuedWords } from '../../packages/myco-server/ui/src/pages/AgentRuns';
import { describeActivity } from '../../packages/myco-server/ui/src/pages/ProjectHome';
import { HELD_BY_WORDS } from '../../packages/myco-server/src/core/limits';

describe('a queued run in the reader\'s words', () => {
  it('names its place and what holds it', () => {
    expect(queuedWords({ position: 0, heldBy: 'concurrent_runs' })).toBe('waiting — next in line · held by the limit on runs at once');
    expect(queuedWords({ position: 2, heldBy: 'task_runs_per_hour' })).toBe('waiting — 2 ahead of it · held by the limit on runs of this task per hour');
    expect(queuedWords({ position: 1, heldBy: 'fleet' })).toBe('waiting — 1 ahead of it · held by the size of the fleet');
    expect(queuedWords({ position: null, heldBy: null })).toBe('waiting — next in line · held by a limit');
  });

  it('words every holder the server can name, in the server\'s own words', () => {
    for (const [holder, words] of Object.entries(HELD_BY_WORDS)) {
      expect(queuedWords({ position: 0, heldBy: holder })).toBe(`waiting — next in line · held by ${words}`);
    }
  });

  it('counts waiting runs on the home\'s activity line', () => {
    expect(describeActivity(1, 1, 2)).toBe('1 open session · 1 run running · 2 waiting');
    expect(describeActivity(0, 0, 1)).toBe('1 waiting');
    expect(describeActivity(0, 0)).toBe('Quiet right now — nothing running.');
  });
});
