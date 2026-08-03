// @vitest-environment jsdom

/**
 * T5 (E-4 W2) family (c) — the Release provenance dialog renders the uniform
 * HostedUnavailable panel (not a raw error box) when the `degrade`-stamped
 * GET /api/release-provenance/:ns/:id 409s capability_unavailable_hosted for an
 * attached (hosted) project, and keeps today's real error box on a genuine
 * outage (503).
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from '../helpers/vi-shim.js';
import { ApiError } from '../../packages/myco/ui/src/lib/api';

const HOSTED_MESSAGE = /isn't available for projects hosted on a Team Host yet/;

const useReleaseProvenanceDetailMock = vi.fn();

mock.module('../../packages/myco/ui/src/hooks/use-release-provenance', () => ({
  useReleaseProvenanceDetail: (...args: unknown[]) => useReleaseProvenanceDetailMock(...args),
}));

mock.module('../../packages/myco/ui/src/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) => (
    <div data-open={open ? 'true' : 'false'}>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import { ReleaseStateBadge } from '../../packages/myco/ui/src/components/release-state/ReleaseStateBadge';

function canopyRefusal() {
  return new ApiError(409, {
    error: 'capability_unavailable_hosted',
    capability: 'Git provenance',
    message: 'Git provenance is unavailable for projects served by a host in this version.',
    retryable: false,
  });
}
function outage() {
  return new ApiError(503, { error: 'host_unreachable', host_id: 'h', message: 'down', retryable: true });
}

function openDialog() {
  render(
    <MemoryRouter>
      <ReleaseStateBadge
        annotation={{ state: 'released', confidence: 'high' }}
        namespace="sessions"
        recordId="sess-1"
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Release provenance:/ }));
}

beforeEach(() => {
  useReleaseProvenanceDetailMock.mockReset();
});

describe('ReleaseProvenanceDialog hosted-degrade', () => {
  it('renders the HostedUnavailable panel on the degraded 409', async () => {
    useReleaseProvenanceDetailMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: canopyRefusal(),
    });
    openDialog();
    await waitFor(() => expect(screen.getByText(HOSTED_MESSAGE)).toBeDefined());
    expect(screen.queryByText(/Failed to load release provenance/)).toBeNull();
  });

  it('keeps the real error box on a genuine outage', async () => {
    useReleaseProvenanceDetailMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: outage(),
    });
    openDialog();
    // ApiError.message surfaces the refusal's HUMAN message, never the
    // mechanism code (apiErrorMessage prefers the sibling `message`).
    await waitFor(() => expect(screen.getByText(/down \(API 503\)/)).toBeDefined());
    expect(screen.queryByText(HOSTED_MESSAGE)).toBeNull();
  });
});
