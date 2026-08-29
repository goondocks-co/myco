import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchJson, postJson } from '../lib/api';

export interface MemberRow {
  id: string;
  label: string | null;
  linked: boolean;
  createdAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  liveCredentials: number;
}

export interface InvitationRow {
  id: string;
  memberId: string | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface CredentialRow {
  id: string;
  memberId: string;
  machineId: string | null;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  bytesWritten: number;
  lineageStartedAt: number;
  firstUsedAt: number | null;
  live: boolean;
}

export interface ActivityRow {
  eventId: string;
  projectId: string;
  sessionId: string;
  kind: string;
  createdAt: number;
  receivedAt: number;
}

export interface GrantRow {
  id: string;
  projectId: string;
  label: string | null;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  rotatedTo: string | null;
}

interface Page<T> { rows: T[]; cursor: string | null }

export function useMembers() {
  return useQuery({ queryKey: ['members'], queryFn: ({ signal }) => fetchJson<{ members: MemberRow[] }>('/api/members', signal) });
}

export function useInvitations() {
  return useQuery({ queryKey: ['invitations'], queryFn: ({ signal }) => fetchJson<{ invitations: InvitationRow[] }>('/api/enrollment', signal) });
}

export function useGrants(projectId: string) {
  return useQuery({
    queryKey: ['grants', projectId],
    queryFn: ({ signal }) => fetchJson<{ grants: GrantRow[] }>(`/api/projects/${encodeURIComponent(projectId)}/grants`, signal),
  });
}

/** A cursor-paged read, page after page; `more()` fetches the next while a cursor remains. Refetch, focus and remount all keep one copy of every row. */
export function usePaged<T>(key: readonly unknown[], path: string) {
  const query = useInfiniteQuery({
    queryKey: [...key],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchJson<Page<T>>(pageParam === null ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(pageParam)}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
  });
  return {
    rows: query.data?.pages.flatMap((p) => p.rows) ?? [],
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    more: () => { void query.fetchNextPage(); },
  };
}

const REFUSALS: Record<string, string> = {
  last_member: 'This is the last member with a connected account; the server would be left with nobody who can sign in.',
  already_revoked: 'Already removed.',
  member_revoked: 'That member has been removed.',
  bad_request: 'The server could not accept that.',
};

/** What to tell the person when the server refused, in their words. */
export function refusalText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown; reason?: unknown } | null;
    const code = body?.error;
    if (typeof code === 'string' && REFUSALS[code]) return typeof body?.reason === 'string' ? `${REFUSALS[code]} ${body.reason}.` : REFUSALS[code];
    if (err.status === 404) return 'That is no longer here.';
    return `The server refused (${err.status}).`;
  }
  return 'Could not reach the server.';
}

/** One mutation per access act; each refreshes the lists it changes. */
export function useAccessActions() {
  const client = useQueryClient();
  const refresh = (...keys: string[]) => Promise.all(keys.map((k) => client.invalidateQueries({ queryKey: [k] })));
  return {
    revokeMember: useMutation({ mutationFn: (id: string) => postJson<{ revoked: boolean }>(`/api/members/${encodeURIComponent(id)}/revoke`), onSuccess: () => refresh('members', 'invitations', 'credentials') }),
    // A minted key lives only in the page's own state: the mutation keeps no copy once it has answered.
    mintInvitation: useMutation({ gcTime: 0, mutationFn: (body: { memberId?: string; ttlMinutes?: number }) => postJson<{ key: string; id: string; expiresAt: number }>('/api/enrollment', body), onSuccess: () => refresh('invitations') }),
    revokeInvitation: useMutation({ mutationFn: (id: string) => postJson<{ revoked: boolean }>(`/api/enrollment/${encodeURIComponent(id)}/revoke`), onSuccess: () => refresh('invitations') }),
    revokeCredential: useMutation({ mutationFn: (id: string) => postJson<{ revoked: boolean }>(`/api/credentials/${encodeURIComponent(id)}/revoke`), onSuccess: () => refresh('credentials', 'members') }),
    mintGrant: useMutation({ gcTime: 0, mutationFn: (v: { projectId: string; label?: string }) => postJson<{ key: string; id: string }>(`/api/projects/${encodeURIComponent(v.projectId)}/grants`, v.label === undefined ? {} : { label: v.label }), onSuccess: () => refresh('grants') }),
    rotateGrant: useMutation({ gcTime: 0, mutationFn: (v: { projectId: string; grantId: string }) => postJson<{ key: string; id: string }>(`/api/projects/${encodeURIComponent(v.projectId)}/grants/${encodeURIComponent(v.grantId)}/rotate`), onSuccess: () => refresh('grants') }),
    revokeGrant: useMutation({ mutationFn: (v: { projectId: string; grantId: string }) => postJson<{ revoked: boolean }>(`/api/projects/${encodeURIComponent(v.projectId)}/grants/${encodeURIComponent(v.grantId)}/revoke`), onSuccess: () => refresh('grants') }),
  };
}
