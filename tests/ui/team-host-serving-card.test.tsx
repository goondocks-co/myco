// @vitest-environment jsdom
/**
 * TeamHostServingCard (E-4 W1 Task T6, Machine Dashboard operator card) —
 * the unconditional card showing THIS machine's own Team Host serving
 * state. Mocks useHostServeStatus directly (its polling contract is pinned
 * separately in use-host-serve-status.test.tsx) so these tests focus on
 * what the card renders for each response shape: no card while loading or
 * not serving, full render with mixed health tones while serving, and the
 * disk-drift divergence case rendered honestly rather than suppressed.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { vi } from '../helpers/vi-shim.js';
import type { HostServeStatusResponse } from '../../packages/myco/ui/src/hooks/use-host-serve-status';

const useHostServeStatusMock = vi.fn();
mock.module('../../packages/myco/ui/src/hooks/use-host-serve-status', () => ({
  useHostServeStatus: (...args: unknown[]) => useHostServeStatusMock(...args),
}));

import { TeamHostServingCard } from '../../packages/myco/ui/src/components/operations/TeamHostServingCard';

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
  external_mcp: { enabled: false, port: 4919, bound: null, token_present: false },
  bearer_present: true,
  health: { designation: 'ok', backup: 'stale', key: 'missing_key', mcp_coherence: 'not_enabled' },
};

describe('TeamHostServingCard', () => {
  beforeEach(() => {
    useHostServeStatusMock.mockReset();
  });

  it('renders nothing while the status query is loading', () => {
    setStatus(undefined);
    const { container } = render(<TeamHostServingCard />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when this machine is not serving — the 99% case', () => {
    setStatus({ serving: false });
    const { container } = render(<TeamHostServingCard />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the full card with mixed health tones (ok / stale / missing key / not enabled) when serving', () => {
    setStatus(SERVING_FIXTURE);
    render(<TeamHostServingCard />);

    expect(screen.getByText('Serving')).toBeInTheDocument();
    expect(screen.getByText('Home Lab')).toBeInTheDocument();
    expect(screen.getByText('grove_1')).toBeInTheDocument();
    expect(screen.getByText('100.64.1.2')).toBeInTheDocument();
    expect(screen.getByText('Mac Studio')).toBeInTheDocument();
    expect(screen.getByText('host_abc')).toBeInTheDocument();
    expect(screen.getByText('Set')).toBeInTheDocument(); // bearer_present
    expect(screen.getByText('ok')).toBeInTheDocument(); // designation
    expect(screen.getByText('stale')).toBeInTheDocument(); // backup
    expect(screen.getByText('missing key')).toBeInTheDocument(); // key
    expect(screen.getByText('not enabled')).toBeInTheDocument(); // mcp_coherence
    expect(screen.getByText(/^Off$/)).toBeInTheDocument(); // external_mcp.enabled === false
  });

  it('renders the restart hint and "Needs attention" badge for the disk-drift divergence case, without suppressing the rest of the card', () => {
    setStatus({
      ...SERVING_FIXTURE,
      health: { ...SERVING_FIXTURE.health, designation: 'dangling' },
    });
    render(<TeamHostServingCard />);

    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText(/Restart the daemon/i)).toBeInTheDocument();
    // Still shows the rest of the card — the divergence must not suppress it.
    expect(screen.getByText('Home Lab')).toBeInTheDocument();
    expect(screen.getByText('dangling')).toBeInTheDocument();
  });

  it('never renders classifier/mechanism jargon in visible copy', () => {
    setStatus(SERVING_FIXTURE);
    const { container } = render(<TeamHostServingCard />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/designation/i);
    expect(text).not.toMatch(/classifier/i);
    expect(text).not.toMatch(/coherence/i);
  });
});
