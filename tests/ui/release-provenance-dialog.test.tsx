// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from '../helpers/vi-shim.js';
import type { ReleaseProvenanceDetail } from '../../packages/myco/ui/src/hooks/use-release-provenance';

const useReleaseProvenanceDetailMock = vi.fn();

mock.module('../../packages/myco/ui/src/hooks/use-release-provenance', () => ({
  useReleaseProvenanceDetail: (...args: unknown[]) => useReleaseProvenanceDetailMock(...args),
}));

mock.module('../../packages/myco/ui/src/components/ui/dialog', () => ({
  Dialog: ({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (open: boolean) => void; children: React.ReactNode }) => (
    <div data-open={open ? 'true' : 'false'} onClick={() => onOpenChange?.(false)}>{children}</div>
  ),
  DialogTrigger: ({ asChild, children }: { asChild?: boolean; children: React.ReactNode }) => asChild ? <>{children}</> : <button>{children}</button>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import {
  ReleaseStateBadge,
  ReleaseStateDot,
} from '../../packages/myco/ui/src/components/release-state/ReleaseStateBadge';

const detail: ReleaseProvenanceDetail = {
  namespace: 'sessions',
  record_id: 'sess-1',
  annotation: {
    state: 'released',
    confidence: 'high',
    basis_kind: 'git_ancestry',
    basis_ref: 'refs/tags/myco/v1.2.5',
    basis_sha: 'abc123',
    reason: 'Captured HEAD is contained in production ref refs/tags/myco/v1.2.5',
    checked_at: 1_782_680_000,
    source_session_id: 'sess-1',
    source_prompt_batch_id: 42,
    release_pr_number: 123,
  },
  evidence: {
    value: { matched_ref: 'refs/tags/myco/v1.2.5', commits_ahead: 0 },
    parse_warning: null,
    available: true,
  },
  git_provenance: [{
    id: 1,
    capture_point: 'session_end',
    captured_at: 1_782_679_990,
    branch: 'ck/daemon-ui-polish',
    head_sha: 'abc123',
    upstream_ref: 'refs/heads/main',
    production_ref: 'refs/tags/myco/v1.2.5',
    is_dirty: false,
    staged_count: 1,
    unstaged_count: 2,
    untracked_count: 0,
    changed_paths: ['packages/myco/ui/src/components/release-state/ReleaseStateBadge.tsx'],
    patch_ids: ['patch-1'],
    error: null,
  }],
  readiness: {
    enabled: true,
    production_refs: ['refs/tags/myco/v1.2.5'],
    integration_refs: ['refs/heads/main'],
    github: {
      repo_configured: true,
      token_available: false,
    },
    warnings: ['repo_configured_but_token_missing'],
  },
};

function setDetailState(state: Partial<ReturnType<typeof useReleaseProvenanceDetailMock>> = {}) {
  useReleaseProvenanceDetailMock.mockReturnValue({
    data: detail,
    isLoading: false,
    isError: false,
    error: null,
    ...state,
  });
}

describe('Release provenance dialog', () => {
  beforeEach(() => {
    useReleaseProvenanceDetailMock.mockReset();
    setDetailState();
  });

  it('opens from the badge and shows evidence, reason, readiness, and settings link', async () => {
    render(
      <MemoryRouter>
        <ReleaseStateBadge annotation={detail.annotation} namespace="sessions" recordId="sess-1" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Release provenance: released/ }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Captured HEAD is contained in production ref refs/tags/myco/v1.2.5')).toBeInTheDocument();
      expect(screen.getByText(/matched_ref/)).toBeInTheDocument();
      expect(screen.getByText('repo_configured_but_token_missing')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Release provenance settings/ })).toHaveAttribute(
      'href',
      '/settings?configSection=release-provenance#release-provenance',
    );
  });

  it('opens from the dot without triggering the parent row action', async () => {
    const onParentClick = vi.fn();

    render(
      <MemoryRouter>
        <div role="button" tabIndex={0} onClick={onParentClick}>
          <ReleaseStateDot annotation={detail.annotation} namespace="sessions" recordId="sess-1" />
        </div>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Release provenance: released/ }));

    expect(onParentClick).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });
});
