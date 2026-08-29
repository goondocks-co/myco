import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchJson, postJson } from '../lib/api';

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

/** A cursor-paged read accumulated page by page; `more()` fetches the next page while a cursor remains. */
export function usePaged<T>(key: readonly unknown[], path: string) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<T[][]>([]);
  const query = useQuery({
    queryKey: [...key, cursor],
    queryFn: async ({ signal }) => {
      const page = await fetchJson<Page<T>>(cursor === null ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`, signal);
      setPages((prev) => (cursor === null ? [page.rows] : [...prev, page.rows]));
      return page;
    },
  });
  return {
    rows: pages.flat(),
    isPending: query.isPending,
    error: query.error,
    hasMore: query.data?.cursor != null,
    more: () => { if (query.data?.cursor) setCursor(query.data.cursor); },
    reset: () => { setPages([]); setCursor(null); },
  };
}

/** One mutation per access act; each refreshes the lists it changes. */
export function useAccessActions() {
  const client = useQueryClient();
  const refresh = (...keys: string[]) => Promise.all(keys.map((k) => client.invalidateQueries({ queryKey: [k] })));
  return {
    revokeMember: useMutation({ mutationFn: (id: string) => postJson<{ revoked: boolean }>(`/api/members/${encodeURIComponent(id)}/revoke`), onSuccess: () => refresh('members', 'invitations', 'credentials') }),
    mintInvitation: useMutation({ mutationFn: (body: { memberId?: string; ttlMinutes?: number }) => postJson<{ key: string; id: string; expiresAt: number }>('/api/enrollment', body), onSuccess: () => refresh('invitations') }),
    revokeInvitation: useMutation({ mutationFn: (id: string) => postJson<{ revoked: boolean }>(`/api/enrollment/${encodeURIComponent(id)}/revoke`), onSuccess: () => refresh('invitations') }),
    revokeCredential: useMutation({ mutationFn: (id: string) => postJson<{ revoked: boolean }>(`/api/credentials/${encodeURIComponent(id)}/revoke`), onSuccess: () => refresh('credentials', 'members') }),
    mintGrant: useMutation({ mutationFn: (v: { projectId: string; label?: string }) => postJson<{ key: string; id: string }>(`/api/projects/${encodeURIComponent(v.projectId)}/grants`, v.label === undefined ? {} : { label: v.label }), onSuccess: () => refresh('grants') }),
    rotateGrant: useMutation({ mutationFn: (v: { projectId: string; grantId: string }) => postJson<{ key: string; id: string }>(`/api/projects/${encodeURIComponent(v.projectId)}/grants/${encodeURIComponent(v.grantId)}/rotate`), onSuccess: () => refresh('grants') }),
    revokeGrant: useMutation({ mutationFn: (v: { projectId: string; grantId: string }) => postJson<{ revoked: boolean }>(`/api/projects/${encodeURIComponent(v.projectId)}/grants/${encodeURIComponent(v.grantId)}/revoke`), onSuccess: () => refresh('grants') }),
  };
}
