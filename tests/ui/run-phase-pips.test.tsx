// @vitest-environment jsdom

import { describe, expect, it } from 'bun:test';
import { render } from '@testing-library/react';
import { RunPhasePips } from '../../packages/myco/ui/src/components/agent/RunList';

describe('RunPhasePips', () => {
  it('renders one pip per checkpoint with phase state tones', () => {
    const { container } = render(
      <RunPhasePips
        status="running"
        phases={[
          { name: 'read-state', status: 'completed', updatedAt: 1 },
          { name: 'write', status: 'running', updatedAt: 2 },
          { name: 'verify', status: 'pending', updatedAt: 3 },
          { name: 'publish', status: 'failed', updatedAt: 4 },
        ]}
      />,
    );

    const pips = container.querySelectorAll('[data-state]');
    expect(pips.length).toBe(4);
    expect([...pips].map((pip) => pip.getAttribute('data-state'))).toEqual([
      'done',
      'active',
      'pending',
      'failed',
    ]);
  });

  it('renders nothing when no checkpoints are available', () => {
    const { container } = render(<RunPhasePips status="completed" phases={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
