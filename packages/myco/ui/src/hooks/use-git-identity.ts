import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface GitIdentity {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  author: string;
  author_email: string;
  head_sha: string;
}

export function useGitIdentity() {
  return usePowerQuery<GitIdentity>({
    queryKey: ['git-identity'],
    queryFn: ({ signal }) => fetchJson<GitIdentity>('/api/git/status', { signal }),
    refetchInterval: POLL_INTERVALS.GIT_IDENTITY,
    pollCategory: 'standard',
  });
}

export function gitIdentityInitials(author: string | undefined): string {
  if (!author) return '?';
  const trimmed = author.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}
