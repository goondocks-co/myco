// @vitest-environment jsdom
/**
 * TeamHostServedCard (E-4 W1 Task T6, Grove Dashboard conditional card) —
 * renders ONLY when this machine serves the CURRENTLY VIEWED Grove to a
 * team. Mocks useHostServeStatus directly (polling contract pinned
 * separately in use-host-serve-status.test.tsx).
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { vi } from '../helpers/vi-shim.js';
import type { HostServeStatusResponse } from '../../packages/myco/ui/src/hooks/use-host-serve-status';

const useHostServeStatusMock = vi.fn();
mock.module('../../packages/myco/ui/src/hooks/use-host-serve-status', () => ({
  useHostServeStatus: (...args: unknown[]) => useHostServeStatusMock(...args),
}));

import { TeamHostServedCard } from '../../packages/myco/ui/src/components/grove/TeamHostServedCard';

function setStatus(data: HostServeStatusResponse | undefined) {
  useHostServeStatusMock.mockReturnValue({ data, isLoading: data === undefined, isError: false });
}

const SERVING_FIXTURE: HostServeStatusResponse = {
  serving: true,
  served_grove_id: 'grove_1',
  served_grove_name: 'Home Lab',
  overlay_address: '100.64.1.2',
  host_id: 'host_abc',
  label: 'Mac Studio',
  external_mcp: { enabled: true, port: 4919, bound: true, token_present: true },
  bearer_present: true,
  health: { designation: 'ok', backup: 'ok', key: 'not_applicable', mcp_coherence: 'ok' },
};

function wrap(node: ReactElement) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

describe('TeamHostServedCard', () => {
  beforeEach(() => {
    useHostServeStatusMock.mockReset();
  });

  it('renders nothing while loading', () => {
    setStatus(undefined);
    const { container } = render(wrap(<TeamHostServedCard groveId="grove_1" />));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when not serving', () => {
    setStatus({ serving: false });
    const { container } = render(wrap(<TeamHostServedCard groveId="grove_1" />));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when serving a DIFFERENT Grove than the one being viewed', () => {
    setStatus(SERVING_FIXTURE); // served_grove_id: 'grove_1'
    const { container } = render(wrap(<TeamHostServedCard groveId="grove_2" />));
    expect(container.firstChild).toBeNull();
  });

  it('renders when the viewed Grove matches the served Grove, linking to the machine-scoped Team page (E1 §5.4)', () => {
    setStatus(SERVING_FIXTURE);
    render(wrap(<TeamHostServedCard groveId="grove_1" />));

    expect(screen.getByText('Served to your team by this machine')).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/team');
  });

  it('renders backup/key/external-access health badges', () => {
    setStatus(SERVING_FIXTURE);
    render(wrap(<TeamHostServedCard groveId="grove_1" />));

    // health.backup='ok', health.key='not_applicable', health.mcp_coherence='ok'
    expect(screen.getAllByText('ok').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('not applicable')).toBeInTheDocument();
  });

  it('shows an "Off" badge for external access when the toggle itself is disabled, independent of mcp_coherence', () => {
    setStatus({
      ...SERVING_FIXTURE,
      external_mcp: { enabled: false, port: 4919, bound: null, token_present: false },
      health: { ...SERVING_FIXTURE.health, mcp_coherence: 'not_enabled' },
    });
    render(wrap(<TeamHostServedCard groveId="grove_1" />));

    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('never renders classifier/mechanism jargon in visible copy', () => {
    setStatus(SERVING_FIXTURE);
    const { container } = render(wrap(<TeamHostServedCard groveId="grove_1" />));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/designation/i);
    expect(text).not.toMatch(/classifier/i);
    expect(text).not.toMatch(/coherence/i);
  });
});
