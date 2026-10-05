import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchJson, patchJson, postJson } from '../lib/api';
import type { InvitationsAnswer, MembersAnswer, MintedInvitation } from '../features/admin/wire';
import { MACHINE_LIST_KEY } from '../features/admin/machines';
export { usePaged } from './use-paged';

export type { ActivityRow, CredentialRow, InvitationRow, MemberRow } from '../features/admin/wire';

export function useMembers() {
  return useQuery({ queryKey: ['members'], queryFn: ({ signal }) => fetchJson<MembersAnswer>('/api/members', signal) });
}

/** Open invitations; asked only where `enabled`, which a page sets for an admin, the only member the server answers them to. */
export function useInvitations(options: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: ['invitations'], queryFn: ({ signal }) => fetchJson<InvitationsAnswer>('/api/enrollment', signal), enabled: options.enabled ?? true });
}

const REFUSALS: Record<string, string> = {
  last_member: 'This is the last member with a connected account; the server would be left with nobody who can sign in.',
  last_admin: 'This is the only admin who can sign in; add or link another admin first.',
  already_revoked: 'Already removed.',
  member_revoked: 'That member has been removed.',
  member_linked: 'That member already has a GitHub account connected. Changing it needs the server operator.',
  member_is_runtime: 'That is Myco’s own account; nobody signs in as it.',
  bad_request: 'The server could not accept that.',
  already_archived: 'Already archived.',
  not_archived: 'Not archived.',
};

/** What to tell the person when the server refused, in their words. */
export function refusalText(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.code;
    if (code !== undefined && REFUSALS[code]) return REFUSALS[code];
    if (err.status === 404) return 'That is no longer here.';
    return `The server refused (${err.status}).`;
  }
  return 'Could not reach the server.';
}

/** What stopping several credentials came to: those stopped, and each that was not with why. */
export interface RevokeOutcome {
  stopped: string[];
  failed: Array<{ id: string; error: unknown }>;
}

/** The reads a machine's name appears in, by the first part of their query key. */
export const MACHINE_NAME_READS = [MACHINE_LIST_KEY[0], 'status', 'today', 'sessions', 'session', 'work', 'runs', 'run'] as const;

/** One mutation per access act; each refreshes the lists it changes. */
export function useAccessActions() {
  const client = useQueryClient();
  const refresh = (...keys: string[]) => Promise.all(keys.map((k) => client.invalidateQueries({ queryKey: [k] })));
  return {
    revokeMember: useMutation({ mutationFn: (id: string) => postJson<{ revoked: boolean }>(`/api/members/${encodeURIComponent(id)}/revoke`), onSuccess: () => refresh('members', 'invitations', 'credentials', 'machines') }),
    changeRole: useMutation({
      mutationFn: ({ memberId, role, expectedRevision }: { memberId: string; role: 'admin' | 'member'; expectedRevision: string }) =>
        postJson<{ memberId: string; role: 'admin' | 'member'; roleRevision: string }>(`/api/members/${encodeURIComponent(memberId)}/role`, { member_id: memberId, role, expected_revision: expectedRevision }),
      onSettled: () => refresh('members', 'ownership'),
    }),
    // A minted key lives only in the page's own state: the mutation keeps no copy once it has answered.
    mintInvitation: useMutation({ gcTime: 0, mutationFn: (body: { memberId?: string; ttlMinutes: number }) => postJson<MintedInvitation>('/api/enrollment', body), onSuccess: () => refresh('invitations') }),
    // The link's key lives only in the page's own state, as an invitation's does.
    linkGithub: useMutation({ gcTime: 0, mutationFn: (memberId: string) => postJson<{ key: string; expiresAt: number }>(`/api/members/${encodeURIComponent(memberId)}/link-github`) }),
    revokeInvitation: useMutation({ mutationFn: (id: string) => postJson<{ revoked: boolean }>(`/api/enrollment/${encodeURIComponent(id)}/revoke`), onSuccess: () => refresh('invitations') }),
    /**
     * Stops every credential named: a machine's live sign-ins, or one run's.
     * Each is asked for on its own and every answer is kept, so a failure part
     * way through says which stopped and which did not.
     */
    revokeCredentials: useMutation({
      mutationFn: async (ids: readonly string[]): Promise<RevokeOutcome> => {
        const outcome: RevokeOutcome = { stopped: [], failed: [] };
        for (const id of ids) {
          try {
            await postJson<{ revoked: boolean }>(`/api/credentials/${encodeURIComponent(id)}/revoke`);
            outcome.stopped.push(id);
          } catch (error) {
            outcome.failed.push({ id, error });
          }
        }
        return outcome;
      },
      onSettled: () => refresh('credentials', 'members'),
    }),
    stopMachine: useMutation({
      mutationFn: (machineId: string) => postJson<{ revoked: number; revokedBy: string }>(`/api/machines/${encodeURIComponent(machineId)}/stop`),
      onSettled: () => refresh('machines', 'members', 'status'),
    }),
    /**
     * Renames a machine, then refreshes every read that names it: the machine
     * lists, the fleet and capture on Today and Health, and the sessions and
     * runs that say where work ran.
     */
    renameMachine: useMutation({
      mutationFn: ({ machineId, name }: { machineId: string; name: string }) =>
        patchJson<{ machineId: string; name: string }>(`/api/machines/${encodeURIComponent(machineId)}`, { label: name }),
      onSuccess: () => refresh(...MACHINE_NAME_READS),
    }),
  };
}
