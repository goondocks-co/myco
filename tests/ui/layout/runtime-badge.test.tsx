// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';

let runtimeSource: string | undefined = 'stable';

mock.module('../../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({
    data: {
      daemon: {
        runtime: runtimeSource ? { source: runtimeSource } : undefined,
        version: '0.25.0',
        version_label: '0.25.0-dev',
      },
    },
  }),
}));

import { RuntimeBadge } from '../../../packages/myco/ui/src/layout/Layout';

describe('RuntimeBadge', () => {
  it('maps manual runtime source to DEV while preserving the raw source in the tooltip', () => {
    runtimeSource = 'manual';
    render(<RuntimeBadge collapsed />);

    const badge = screen.getByText('DEV');
    expect(badge).toBeDefined();
    expect(badge.getAttribute('title')).toBe('Daemon channel: manual');
  });

  it('keeps the expanded runtime badge focused on the channel label', () => {
    runtimeSource = 'manual';
    render(<RuntimeBadge collapsed={false} />);

    const badge = screen.getByText('DEV');
    expect(badge).toBeDefined();
    expect(badge.textContent).toBe('DEV');
    expect(screen.queryByText(/0\.25\.0/)).toBeNull();
  });

  it('maps beta runtime source to BETA while preserving the raw source in the tooltip', () => {
    runtimeSource = 'beta';
    render(<RuntimeBadge collapsed />);

    const badge = screen.getByText('BETA');
    expect(badge).toBeDefined();
    expect(badge.getAttribute('title')).toBe('Daemon channel: beta');
  });

  it('hides the badge for stable runtime source', () => {
    runtimeSource = 'stable';
    const { container } = render(<RuntimeBadge collapsed={false} />);

    expect(container.textContent).toBe('');
  });
});
