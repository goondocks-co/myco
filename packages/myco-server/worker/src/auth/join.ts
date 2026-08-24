import type { ServerEnv } from '../core/adapters.js';
import { MEMBER_ID_PREFIX } from '../constants.js';
import { emit, type Classifier } from '../telemetry.js';
import { claimMachineIdentity, ensureMember, reclaimEnrollmentAuthorities, spendEnrollmentAuthority, type EnrollmentRefusal } from './enrollment.js';
import { issueMemberToken } from './tokens.js';

/** The identity grammar a join may record: machine id, runtime label and runtime kind all answer to it. */
const IDENTITY = /^[A-Za-z0-9._-]{1,64}$/;

/** Bytes of randomness in a server-named member id. */
const MEMBER_ID_BYTES = 12;

/** Every refusal a join answers, each the classifier the wire carries. */
const REFUSALS: Record<EnrollmentRefusal, Classifier> = {
  unknown: 'enrollment_unknown',
  already_used: 'enrollment_used',
  expired: 'enrollment_expired',
  revoked: 'enrollment_revoked',
};

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface JoinBody {
  key?: unknown;
  machineId?: unknown;
  runtimeLabel?: unknown;
  runtimeKind?: unknown;
}

const refuse = (code: Classifier, reason: string): Response =>
  Response.json({ joined: false, code, reason });

/**
 * `POST /members/join`: an enrollment authority is exchanged, once, for a member
 * credential.
 *
 * What the joiner sends and what the server believes are deliberately different
 * sets. The key decides WHO joins — a key minted against an existing member adds
 * a runtime to that member, one minted without names a new one — and the joiner
 * never names its member at all, so a stolen key cannot be pointed at somebody
 * else's identity. `machineId` is recorded from the request, the one thing only
 * the runtime knows, and is immutable from that moment. `runtimeLabel` and
 * `runtimeKind` are claims kept for an operator to read; nothing downstream
 * admits or refuses anything on their basis.
 *
 * The spend runs ahead of the credential and is a single conditional update, so
 * two runtimes racing one key produce one credential and one `enrollment_used` —
 * never two credentials, and never a spent key with nothing issued against it.
 */
export async function handleJoin(env: ServerEnv, request: Request, now: number): Promise<Response> {
  let body: JoinBody;
  try {
    body = (await request.json()) as JoinBody;
  } catch {
    return refuse('parse', 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse('parse', 'body must be an object');

  const { key, machineId, runtimeLabel, runtimeKind, ...rest } = body;
  const [unknownField] = Object.keys(rest);
  if (unknownField !== undefined) return refuse('unknown_field', `unknown field ${unknownField}`);
  if (typeof key !== 'string') return refuse('enrollment_unknown', 'key required');
  if (typeof machineId !== 'string' || !IDENTITY.test(machineId)) return refuse('id_grammar', 'machineId must match the machine-id grammar');
  for (const [name, value] of [['runtimeLabel', runtimeLabel], ['runtimeKind', runtimeKind]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !IDENTITY.test(value))) return refuse('id_grammar', `${name} must match the machine-id grammar`);
  }

  // The table grows only when someone joins, so this is where it is trimmed —
  // the same opportunistic reclaim expired blob reservations get on the path that
  // replaces them, rather than a schedule this server does not have.
  const { reclaimed } = await reclaimEnrollmentAuthorities(env.db, now);
  if (reclaimed > 0) emit({ kind: 'enrollment_authorities_reclaimed', reclaimed });

  const spend = await spendEnrollmentAuthority(env.db, key, now, machineId);
  if (!spend.ok) {
    const classifier = REFUSALS[spend.reason];
    emit({ kind: 'join_refused', machineId, reason: classifier });
    return refuse(classifier, `enrollment key ${spend.reason.replace('_', ' ')}`);
  }

  const memberId = spend.memberId ?? `${MEMBER_ID_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(MEMBER_ID_BYTES)))}`;
  await ensureMember(env.db, memberId, now);

  // A machine identity belongs to one member. Every ownership predicate the ingest
  // path applies keys on it, so a joiner free to present any identity it liked could
  // write into another member's sessions across the whole Deployment — and a machine
  // id is a label, not a secret. The key says WHO joins; this says the identity they
  // present is not already somebody else's.
  const claim = await claimMachineIdentity(env.db, machineId, memberId, now);
  if (!claim.claimed) {
    emit({ kind: 'join_refused', machineId, reason: 'identity_claimed' });
    return refuse('identity_claimed', 'machine identity belongs to another member');
  }

  const issued = await issueMemberToken(env.db, { memberId, machineId }, now, null, {
    runtimeLabel: typeof runtimeLabel === 'string' ? runtimeLabel : null,
    runtimeKind: typeof runtimeKind === 'string' ? runtimeKind : null,
  });
  emit({ kind: 'member_joined', memberId, tokenId: issued.tokenId, machineId, enrollmentId: spend.id });
  return Response.json({ joined: true, memberId, token: issued.token, tokenId: issued.tokenId, expiresAt: issued.expiresAt });
}
