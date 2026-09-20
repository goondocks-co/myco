import { toBase64Url } from '../base64.js';
import type { ServerEnv } from '../core/adapters.js';
import { MEMBER_ID_PREFIX } from '../constants.js';
import { emit, StorageContractError, type Classifier } from '../telemetry.js';
import {
  allOf, authorityAdmitted, claimMachineIdentityStatement, enrollmentAdmission, ensureMemberStatement, ENROLLMENT_KEY_PATTERN,
  enrollmentTarget, explainEnrollment, machineClaimable, spendStatement,
  type EnrollmentRefusal, type Fragment,
} from './enrollment.js';
import { roleBehindCredentialStatement } from './members-admin.js';
import { asMemberRole } from './roles.js';
import { mintInsert } from './tokens.js';
import { stampRequestStatement } from '../core/activity.js';
import { sha256Hex } from '../hash.js';

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
  let body: JoinBody;
  try {
    body = (await request.json()) as JoinBody;
  } catch {
    return refuse('parse', 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse('parse', 'body must be an object');

  const { key, machineId, runtimeLabel, runtimeKind, forProject, ...rest } = body;
  const [unknownField] = Object.keys(rest);
  if (unknownField !== undefined) return refuse('unknown_field', `unknown field ${unknownField}`);
  if (typeof key !== 'string') return refuse('enrollment_unknown', 'key required');
  if (typeof machineId !== 'string' || !IDENTITY.test(machineId)) return refuse('id_grammar', 'machineId must match the machine-id grammar');
  for (const [name, value] of [['runtimeLabel', runtimeLabel], ['runtimeKind', runtimeKind]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !IDENTITY.test(value))) return refuse('id_grammar', `${name} must match the machine-id grammar`);
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

  const admission = enrollmentAdmission(keyHash, now, { forProject: forProjectAsked, memberId });
  const admitted: Fragment = allOf(authorityAdmitted(admission), machineClaimable(machineId, memberId));
  const runtime = {
    runtimeLabel: typeof runtimeLabel === 'string' ? runtimeLabel : null,
    runtimeKind: typeof runtimeKind === 'string' ? runtimeKind : null,
  };
  const { statement: credential, issued } = await mintInsert(env.db, { memberId, machineId }, now, null, runtime, admitted);
  const minted: Fragment = { sql: `EXISTS (SELECT 1 FROM member_credentials WHERE id = ?)`, params: [issued.tokenId] };
  const roleRead = roleBehindCredentialStatement(env.db, issued.tokenId);

  const statements = [
    ensureMemberStatement(env.db, memberId, now, invitation?.role ?? 'member', admitted),
    claimMachineIdentityStatement(env.db, machineId, memberId, now, admitted),
    credential,
    spendStatement(env.db, admission, now, machineId, minted),
    // Only a committed credential advances the activity clock.
    stampRequestStatement(env.db, now, minted),
    roleRead,
  ];
  const credentialAt = statements.indexOf(credential);
  const results = await env.db.batch(statements);
  if (results.length !== statements.length) throw new StorageContractError(`batch answered ${results.length} results for ${statements.length} statements`);
  const issuedCredential = results[credentialAt]!.meta.changes === 1;

  if (!issuedCredential) {
    // Enrollment refusals precede identity refusals.
    const explained = await explainEnrollment(env.db, key, now, { forProject: forProjectAsked, memberId });
    const classifier: Classifier = explained.admissible ? 'identity_claimed' : REFUSALS[explained.reason];
    return refuseJoin(classifier, explained.admissible
      ? 'machine identity belongs to another member'
      : `enrollment key ${explained.reason.replace('_', ' ')}`);
  }

  const roleRow = results[statements.indexOf(roleRead)]!.results[0] as { role?: unknown } | undefined;
  const committedRole = asMemberRole(roleRow?.role);
  if (committedRole === null) throw new StorageContractError(`credential ${issued.tokenId} inserted but names no member`);

  emit({ kind: 'member_joined', memberId, tokenId: issued.tokenId, machineId, enrollmentId: invitation?.id });
  return Response.json({
    joined: true, memberId, token: issued.token, tokenId: issued.tokenId, expiresAt: issued.expiresAt,
    role: committedRole, projectId: invitation?.projectId ?? null,
  });
}
