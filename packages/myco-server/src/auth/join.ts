import { toBase64Url } from '../base64.js';
import type { ServerEnv } from '../core/adapters.js';
import { MEMBER_ID_PREFIX } from '../constants.js';
import { emit, StorageContractError, type Classifier } from '../telemetry.js';
import {
  allOf, authorityAdmitted, claimMachineIdentityStatement, enrollmentAdmission, ensureMemberStatement,
  enrollmentProject, enrollmentTarget, explainEnrollment, machineClaimable, spendStatement,
  type EnrollmentRefusal, type Fragment,
} from './enrollment.js';
import { roleBehindCredential } from './members-admin.js';
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
 * The whole admission is one transaction. Every write carries the same
 * conditions — the key unspent and live, the invitation naming this member, the
 * machine identity free or already theirs — and the spend carries the credential
 * row those conditions produced. A write whose conditions fail selects no row, so
 * a refused join leaves no member, no claim, no credential and an unspent key.
 *
 * Write transactions serialize, so a second attempt on one key begins after the
 * first commits and finds it spent: its every statement fails, and one key yields
 * one credential.
 *
 * `forProject: true` is a joiner declaring it can only work bound to a Project —
 * a sandbox, which has no local configuration to fall back on. A key carrying no
 * Project is then refused `enrollment_no_project` and stays unspent, so an
 * operator can bind one and hand the same key over rather than mint another.
 * The answer carries the role the key granted and the Project it bound, both
 * fixed at the moment of minting.
 */
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

  const forProjectAsked = forProject === true;
  const keyHash = await sha256Hex(key);
  // The member a new key joins is minted here so every write in the batch can
  // name it; the invitation binds it, so a caller cannot substitute a recipient.
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

  // The role a new member is recorded at is the invitation's. An authority's role
  // is fixed at minting, and the admission revalidates it, so a key carrying one
  // outside the grammar refuses rather than lands.
  const statements = [
    ensureMemberStatement(env.db, memberId, now, invitation?.role ?? 'member', admitted),
    claimMachineIdentityStatement(env.db, machineId, memberId, now, admitted),
    credential,
    spendStatement(env.db, admission, now, machineId, minted),
    // A join leaves no session and no run, so the clock the tick reads sees it
    // only here, and only for a join that issued a credential: an unauthenticated
    // guesser posting keys cannot hold a Deployment awake at the operator's expense.
    stampRequestStatement(env.db, now, minted),
  ];
  const credentialAt = statements.indexOf(credential);
  const results = await env.db.batch(statements);
  if (results.length !== statements.length) throw new StorageContractError(`batch answered ${results.length} results for ${statements.length} statements`);
  const issuedCredential = results[credentialAt]!.meta.changes === 1;

  if (!issuedCredential) {
    // No credential means no write in the batch landed, so the refusal is the
    // key's own, or the machine identity when the key admits nothing against it.
    const explained = await explainEnrollment(env.db, key, now, { forProject: forProjectAsked, memberId });
    // A key nothing refuses, with no credential issued, is the identity: the one
    // condition outside the key that every write in the batch also carried.
    const classifier: Classifier = explained.admissible ? 'identity_claimed' : REFUSALS[explained.reason];
    emit({ kind: 'join_refused', machineId, reason: classifier });
    return refuse(classifier, explained.admissible
      ? 'machine identity belongs to another member'
      : `enrollment key ${explained.reason.replace('_', ' ')}`);
  }

  // The credential landed and the key is spent, so the committed member must be
  // readable: nothing about the key explains its absence.
  const committedRole = await roleBehindCredential(env.db, issued.tokenId);
  if (committedRole === null) throw new StorageContractError(`credential ${issued.tokenId} inserted but names no member`);

  emit({ kind: 'member_joined', memberId, tokenId: issued.tokenId, machineId, enrollmentId: invitation?.id });
  return Response.json({
    joined: true, memberId, token: issued.token, tokenId: issued.tokenId, expiresAt: issued.expiresAt,
    role: committedRole, projectId: await enrollmentProject(env.db, keyHash),
  });
}
