import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchJson, postJson } from '../../../lib/api';
import { formatUntil } from '../../../lib/format';
import { ago } from '../../today/words';
import type { GrantRow, GrantsAnswer } from '../wire';

/** The one value `revokedBy` carries that is not a member: the expiry sweep, which has no actor to name. */
export const GRANT_EXPIRY_ACTOR = 'expiry';

const grantsPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/grants`;
const grantsKey = (projectId: string) => ['grants', projectId] as const;

/** A project's access keys, live and ended. */
export function useGrants(projectId: string) {
  return useQuery({ queryKey: [...grantsKey(projectId)], queryFn: ({ signal }) => fetchJson<GrantsAnswer>(grantsPath(projectId), signal) });
}

/** A key the server answers once. */
export interface MintedKey { key: string; id: string }

/**
 * Adding, rotating and revoking a project's access keys. A key the server
 * answers lives only in the page's own state: these mutations keep no copy once
 * they have answered, and a caller resets them when it lets the key go.
 */
export function useGrantActions(projectId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [...grantsKey(projectId)] });
  const one = (grantId: string, act: 'rotate' | 'revoke') => `${grantsPath(projectId)}/${encodeURIComponent(grantId)}/${act}`;
  return {
    mint: useMutation({ gcTime: 0, mutationFn: (label: string | null) => postJson<MintedKey>(grantsPath(projectId), label === null ? {} : { label }), onSuccess: refresh }),
    rotate: useMutation({ gcTime: 0, mutationFn: (grantId: string) => postJson<MintedKey>(one(grantId, 'rotate')), onSuccess: refresh }),
    revoke: useMutation({ mutationFn: (grantId: string) => postJson<{ revoked: boolean }>(one(grantId, 'revoke')), onSuccess: refresh }),
  };
}

/** What the server said when it refused a change to a key, in the person's words. */
export function keyRefusal(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'already_revoked') return 'That key was already ended.';
    if (err.status === 400 || err.status === 409) return 'The server could not make that change to the key.';
    if (err.status === 404) return 'That key is no longer here.';
    return `The server refused (${err.status}).`;
  }
  return 'Could not reach the server.';
}

/** Whether a key still works. */
export const keyLive = (grant: GrantRow): boolean => grant.revokedAt === null;

/**
 * A key's line of facts: when it was added and by whom, then whether it has
 * been used, when it expires, or how it ended. Never an id: a name a member's
 * label does not give reads as nothing.
 */
export function keyWords(grant: GrantRow, nameOf: (id: string | null) => string | null, now: number = Date.now()): string {
  const by = nameOf(grant.createdBy);
  const added = `Added ${ago(grant.createdAt, now)}${by === null ? '' : ` by ${by}`}`;
  if (grant.revokedAt !== null) {
    if (grant.revokedBy === GRANT_EXPIRY_ACTOR) return `${added} · expired ${ago(grant.revokedAt, now)}`;
    const ender = nameOf(grant.revokedBy);
    return `${added} · ${grant.rotatedTo !== null ? 'replaced' : 'revoked'} ${ago(grant.revokedAt, now)}${ender === null ? '' : ` by ${ender}`}`;
  }
  const used = grant.lastUsedAt === null ? 'never used' : `last used ${ago(grant.lastUsedAt, now)}`;
  const expires = grant.expiresAt === null ? '' : grant.expiresAt <= now ? ' · expired' : ` · expires in ${formatUntil(grant.expiresAt, now, true)}`;
  return `${added} · ${used}${expires}`;
}

/** A key's name: the one it was given, else a plain word. */
export const keyName = (grant: GrantRow): string => (grant.label === null || grant.label.trim() === '' ? 'Unnamed key' : grant.label);
