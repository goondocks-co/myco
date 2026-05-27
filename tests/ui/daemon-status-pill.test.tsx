// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatUptime, DaemonStatusPillView } from '../../packages/myco/ui/src/components/ui/daemon-status-pill';

describe('formatUptime', () => {
  it('formats seconds under a minute', () => {
    expect(formatUptime(45)).toBe('45s');
  });
  it('formats minutes', () => {
    expect(formatUptime(125)).toBe('2m');
  });
  it('formats hours and minutes', () => {
    expect(formatUptime(3 * 3600 + 17 * 60)).toBe('3h 17m');
  });
  it('formats days', () => {
    expect(formatUptime(2 * 86400 + 4 * 3600)).toBe('2d 4h');
  });
});

describe('DaemonStatusPillView', () => {
  it('renders sage dot + daemon label + uptime', () => {
    render(<DaemonStatusPillView uptimeSeconds={3 * 3600 + 17 * 60} />);
    expect(screen.getByText('daemon')).toBeDefined();
    expect(screen.getByText('3h 17m')).toBeDefined();
    expect(screen.getByTestId('status-dot').dataset.tone).toBe('sage');
  });

  it('renders em-dash when uptime is unavailable', () => {
    render(<DaemonStatusPillView uptimeSeconds={undefined} />);
    expect(screen.getByText('—')).toBeDefined();
  });

  it('appends version when provided', () => {
    render(<DaemonStatusPillView uptimeSeconds={60} version="0.25.1" />);
    expect(screen.getByText('v0.25.1')).toBeDefined();
  });

  it('does not double-prefix git describe labels', () => {
    render(<DaemonStatusPillView uptimeSeconds={60} version="v0.18.1-244-g63fe75a5" />);
    expect(screen.getByText('v0.18.1-244-g63fe75a5')).toBeDefined();
  });

  it('links to update settings and indicates update availability', () => {
    render(
      <MemoryRouter>
        <DaemonStatusPillView
          uptimeSeconds={60}
          version="0.25.1"
          updateAvailable
          latestVersion="0.27.19"
          to="/settings?configSection=update#update"
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /daemon/i }).getAttribute('href')).toBe('/settings?configSection=update#update');
    expect(screen.getByTestId('status-dot').dataset.tone).toBe('ochre');
    expect(screen.getByTestId('status-dot').dataset.pulsing).toBe('true');
  });
});
