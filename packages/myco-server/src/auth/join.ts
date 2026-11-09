import { commitNamed, refused } from '../db/index.js';
import { JOIN_REFUSED, joinIdentityRead, joinWrites } from '../db/identity/join.js';
import { toBase64Url } from '../base64.js';
import type { ServerEnv } from '../core/adapters.js';
import { MEMBER_ID_PREFIX } from '../constants.js';
import { emit, StorageContractError, type Classifier } from '../telemetry.js';
import { ENROLLMENT_KEY_PATTERN, ENROLLMENT_IDENTITY_PATTERN, enrollmentTarget, explainEnrollment, type EnrollmentRefusal } from './enrollment.js';
import { asMemberRole } from './roles.js';
import { mintWrite } from './tokens.js';
import { stampRequestWrite } from '../core/activity.js';
import { sha256Hex } from '../hash.js';

/** Bytes of randomness in a server-named member id. */
const MEMBER_ID_BYTES = 12;

/** Every refusal a join answers, each the classifier the wire carries. */
const REFUSALS: Record<EnrollmentRefusal, Classifier> = {
  unknown: 'enrollment_unknown',
  already_used: 'enrollment_used',
  expired: 'enrollment_expired',
  revoked: 'enrollment_revoked',
  no_project: 'enrollment_no_project',
};

interface JoinBody {
  key?: unknown;
  machineId?: unknown;
  runtimeLabel?: unknown;
  runtimeKind?: unknown;
  forProject?: unknown;
}

const refuse = (code: Classifier, reason: string): Response =>
  Response.json({ joined: false, code, reason });

/** Exchanges an enrollment key for a credential; refused joins leave the key and identity records unchanged. */
export async function handleJoin(env: ServerEnv, request: Request, now: number): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse('parse', 'body must be JSON');
  }
  return joinMember(env, body, now);
}

/** Exchanges admitted enrollment evidence for an attributable machine credential in one transaction. */
export async function joinMember(env: ServerEnv, input: unknown, now: number): Promise<Response> {
  const body = input as JoinBody;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse('parse', 'body must be an object');

  const { key, machineId, runtimeLabel, runtimeKind, forProject, ...rest } = body;
  const [unknownField] = Object.keys(rest);
  if (unknownField !== undefined) return refuse('unknown_field', `unknown field ${unknownField}`);
  if (typeof key !== 'string') return refuse('enrollment_unknown', 'key required');
  if (typeof machineId !== 'string' || !ENROLLMENT_IDENTITY_PATTERN.test(machineId)) return refuse('id_grammar', 'machineId must match the machine-id grammar');
  for (const [name, value] of [['runtimeLabel', runtimeLabel], ['runtimeKind', runtimeKind]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !ENROLLMENT_IDENTITY_PATTERN.test(value))) return refuse('id_grammar', `${name} must match the machine-id grammar`);
  }
  if (forProject !== undefined && forProject !== true) return refuse('unknown_field', 'forProject may only be true');

  const refuseJoin = (classifier: Classifier, reason: string): Response => {
    emit({ kind: 'join_refused', machineId, reason: classifier });
    return refuse(classifier, reason);
  };
  if (!ENROLLMENT_KEY_PATTERN.test(key)) return refuseJoin('enrollment_unknown', 'enrollment key unknown');
  const forProjectAsked = forProject === true;
  const keyHash = await sha256Hex(key);
  const invitation = await enrollmentTarget(env.db, keyHash);
  const memberId = invitation?.memberId ?? `${MEMBER_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(MEMBER_ID_BYTES)))}`;

  const runtime = {
    runtimeLabel: typeof runtimeLabel === 'string' ? runtimeLabel : null,
    runtimeKind: typeof runtimeKind === 'string' ? runtimeKind : null,
  };
  const { statement: credential, issued } = await mintWrite(env.db, { memberId, machineId }, now, null, runtime);
  const { admitted, member, claim, spend } = joinWrites({ keyHash, now, memberId, machineId, forProject: forProjectAsked, runtimeLabel: runtime.runtimeLabel });

  let identityRow: { role?: unknown; memberLabel?: string | null; owner?: number } | undefined;
  try {
    const committed = await commitNamed(env.db, {
      admitted, member, claim, credential, spend,
      // Only a committed credential advances the activity clock.
      stamp: stampRequestWrite(now),
      identity: joinIdentityRead(issued.tokenId),
    });
    if (committed.spend.results.length !== 1) throw new StorageContractError(`join spent ${committed.spend.results.length} authorities`);
    identityRow = committed.identity.results[0];
  } catch (error) {
    if (!refused(error, JOIN_REFUSED)) throw error;
    // Enrollment refusals precede identity refusals.
    const explained = await explainEnrollment(env.db, key, now, { forProject: forProjectAsked, memberId });
    const classifier: Classifier = explained.admissible ? 'identity_claimed' : REFUSALS[explained.reason];
    return refuseJoin(classifier, explained.admissible
      ? 'machine identity belongs to another member'
      : `enrollment key ${explained.reason.replace('_', ' ')}`);
  }

  const committedRole = asMemberRole(identityRow?.role);
  if (committedRole === null) throw new StorageContractError(`credential ${issued.tokenId} inserted but names no member`);

  emit({ kind: 'member_joined', memberId, tokenId: issued.tokenId, machineId, enrollmentId: invitation?.id });
  return Response.json({
    memberLabel: identityRow?.memberLabel ?? null, owner: identityRow?.owner === 1,
    joined: true, memberId, token: issued.token, tokenId: issued.tokenId, expiresAt: issued.expiresAt,
    role: committedRole, projectId: invitation?.projectId ?? null,
  });
}
