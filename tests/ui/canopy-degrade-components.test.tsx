// @vitest-environment jsdom

/**
 * T5 (E-4 W2) family (b) — the Canopy display surfaces render the uniform
 * HostedUnavailable state (not a raw error / misleading zeros) when the
 * `degrade`-stamped route 409s capability_unavailable_hosted for an attached
 * (hosted) project, and keep today's real error presentation on a genuine
 * outage (503).
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from '../helpers/vi-shim.js';
import { ApiError } from '../../packages/myco/ui/src/lib/api';
import type { ActivityRow } from '../../packages/myco/ui/src/hooks/use-sessions';

const HOSTED_MESSAGE = /isn't available for projects hosted on a Team Host yet/;

function canopyRefusal() {
  return new ApiError(409, {
    error: 'capability_unavailable_hosted',
    capability: 'Code intelligence (Canopy)',
    message: 'Code intelligence (Canopy) is unavailable for projects served by a host in this version.',
    retryable: false,
  });
}
function outage() {
  return new ApiError(503, { error: 'host_unreachable', host_id: 'h', message: 'down', retryable: true });
}

const useSessionCanopyMock = vi.fn();
const useCanopyMapMock = vi.fn();
const useRegenerateCanopyMapMock = vi.fn(() => ({ mutate: vi.fn(), isPending: false }));
const useCanopyEntriesMock = vi.fn();
const useCanopyInjectionBlobMock = vi.fn();
const useCanopyEntryMock = vi.fn();
const useReembedCanopyEntryMock = vi.fn(() => ({ mutate: vi.fn(), isPending: false }));
const useRedescribeCanopyEntryMock = vi.fn(() => ({ mutate: vi.fn(), isPending: false }));

mock.module('../../packages/myco/ui/src/hooks/use-canopy', () => ({
  useSessionCanopy: (...a: unknown[]) => useSessionCanopyMock(...a),
  useCanopyMap: (...a: unknown[]) => useCanopyMapMock(...a),
  useRegenerateCanopyMap: (...a: unknown[]) => useRegenerateCanopyMapMock(...a),
  useCanopyEntries: (...a: unknown[]) => useCanopyEntriesMock(...a),
  useCanopyInjectionBlob: (...a: unknown[]) => useCanopyInjectionBlobMock(...a),
  useCanopyEntry: (...a: unknown[]) => useCanopyEntryMock(...a),
  useReembedCanopyEntry: (...a: unknown[]) => useReembedCanopyEntryMock(...a),
  useRedescribeCanopyEntry: (...a: unknown[]) => useRedescribeCanopyEntryMock(...a),
  getMycoToolCallCount: () => 0,
}));

// Render Dialog content unconditionally so BlobPanel mounts without a click.
mock.module('../../packages/myco/ui/src/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import { CanopyEfficiencyTile } from '../../packages/myco/ui/src/components/sessions/CanopyEfficiencyTile';
import { CanopyMapPanel } from '../../packages/myco/ui/src/components/canopy/CanopyMapPanel';
import { CanopyEntriesList } from '../../packages/myco/ui/src/components/canopy/CanopyEntriesList';
import { CanopyEntryDetail } from '../../packages/myco/ui/src/components/canopy/CanopyEntryDetail';
import { CanopyToolCallIndicator } from '../../packages/myco/ui/src/components/sessions/CanopyToolCallIndicator';

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

beforeEach(() => {
  useSessionCanopyMock.mockReset();
  useCanopyMapMock.mockReset();
  useCanopyEntriesMock.mockReset();
  useCanopyInjectionBlobMock.mockReset();
  useCanopyEntryMock.mockReset();
});

describe('CanopyEfficiencyTile', () => {
  it('renders HostedUnavailable inline on the degraded 409', () => {
    useSessionCanopyMock.mockReturnValue({ data: undefined, isLoading: false, error: canopyRefusal() });
    wrap(<CanopyEfficiencyTile sessionId="sess-1" />);
    expect(screen.getByText(HOSTED_MESSAGE)).toBeDefined();
    expect(screen.queryByTestId('canopy-efficiency-tile')).toBeNull();
  });

  it('keeps the zeros tile (not HostedUnavailable) on a real outage', () => {
    useSessionCanopyMock.mockReturnValue({ data: undefined, isLoading: false, error: outage() });
    wrap(<CanopyEfficiencyTile sessionId="sess-1" />);
    expect(screen.getByTestId('canopy-efficiency-tile')).toBeDefined();
    expect(screen.queryByText(HOSTED_MESSAGE)).toBeNull();
  });
});

describe('CanopyMapPanel', () => {
  it('renders the HostedUnavailable panel on the degraded 409', () => {
    useCanopyMapMock.mockReturnValue({ data: undefined, isPending: false, isError: true, error: canopyRefusal() });
    wrap(<CanopyMapPanel />);
    expect(screen.getByText(HOSTED_MESSAGE)).toBeDefined();
    expect(screen.queryByText(/Failed to load Canopy Map/)).toBeNull();
  });

  it('keeps the real error state on a genuine outage', () => {
    useCanopyMapMock.mockReturnValue({ data: undefined, isPending: false, isError: true, error: outage() });
    wrap(<CanopyMapPanel />);
    expect(screen.getByText(/Failed to load Canopy Map/)).toBeDefined();
    expect(screen.queryByText(HOSTED_MESSAGE)).toBeNull();
  });
});

describe('CanopyEntriesList', () => {
  it('renders the HostedUnavailable panel on the degraded 409', () => {
    useCanopyEntriesMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: canopyRefusal() });
    wrap(<CanopyEntriesList selectedPath={undefined} onSelectPath={vi.fn()} />);
    expect(screen.getByText(HOSTED_MESSAGE)).toBeDefined();
    expect(screen.queryByText(/Failed to load canopy entries/)).toBeNull();
  });

  it('keeps the real error state on a genuine outage', () => {
    useCanopyEntriesMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: outage() });
    wrap(<CanopyEntriesList selectedPath={undefined} onSelectPath={vi.fn()} />);
    expect(screen.getByText(/Failed to load canopy entries/)).toBeDefined();
    expect(screen.queryByText(HOSTED_MESSAGE)).toBeNull();
  });
});

describe('CanopyEntryDetail', () => {
  it('renders HostedUnavailable inline on the degraded 409 (reachable via the Cortex deep-link), not "Failed to load entry"', () => {
    useCanopyEntryMock.mockReturnValue({ data: undefined, isPending: false, isError: true, error: canopyRefusal() });
    wrap(<CanopyEntryDetail path="src/foo.ts" onClose={vi.fn()} />);
    expect(screen.getByText(HOSTED_MESSAGE)).toBeDefined();
    expect(screen.queryByText('Failed to load entry')).toBeNull();
    expect(screen.queryByTestId('canopy-entry-detail-error')).toBeNull();
  });

  it('keeps the real error state on a genuine outage', () => {
    useCanopyEntryMock.mockReturnValue({ data: undefined, isPending: false, isError: true, error: outage() });
    wrap(<CanopyEntryDetail path="src/foo.ts" onClose={vi.fn()} />);
    expect(screen.getByText('Failed to load entry')).toBeDefined();
    expect(screen.getByTestId('canopy-entry-detail-error')).toBeDefined();
    expect(screen.queryByText(HOSTED_MESSAGE)).toBeNull();
  });
});

describe('CanopyToolCallIndicator blob panel', () => {
  const qualifyingActivity = {
    id: 42,
    session_id: 'sess-1',
    tool_name: 'Read',
    canopy_injection_tokens: 128,
  } as unknown as ActivityRow;

  it('renders HostedUnavailable inline when the blob route degrades (409)', () => {
    useCanopyInjectionBlobMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: canopyRefusal() });
    wrap(<CanopyToolCallIndicator sessionId="sess-1" activity={qualifyingActivity} />);
    expect(screen.getByText(HOSTED_MESSAGE)).toBeDefined();
  });

  it('keeps the real error state on a genuine outage', () => {
    useCanopyInjectionBlobMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: outage() });
    wrap(<CanopyToolCallIndicator sessionId="sess-1" activity={qualifyingActivity} />);
    // The refusal's HUMAN message renders, never the mechanism code
    // (apiErrorMessage prefers the sibling `message` — PR #803 review C5).
    expect(screen.getByText(/down \(API 503\)/)).toBeDefined();
    expect(screen.queryByText(HOSTED_MESSAGE)).toBeNull();
  });
});
