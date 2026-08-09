/**
 * `myco join <host>` / `myco leave <host>` — the member side of team membership.
 *
 * A member holds two things per host: its public URL and a bearer. Both arrive
 * from one enrollment call to that URL; there is no network to stand up first,
 * no local process per host, and nothing to provision.
 *
 * JOIN spends a daemon-minted single-use key at the host's URL and stores what
 * comes back: this member's OWN token, bound by the host to the machine_id
 * asserted at enrollment. The token is never handed out of band — only the URL
 * and the key are, and the key is spent the first time it is used.
 *
 * LEAVE tells the host first (`resignFromHost`), so the host releases its record
 * for this machine, then retires the local one. Best-effort in that order: a
 * host that is unreachable must not be able to hold a member in a membership it
 * is trying to leave, so the local retirement happens regardless and the caller
 * gets a note.
 *
 * MULTI-TEAM is why the shape matters. A machine can belong to several teams at
 * once and every request goes through the member's own daemon, which selects
 * among host records per request. Public URLs are globally unique, so nothing
 * has to disambiguate a dial. Each record carries its own URL and its own token
 * in its own generation file, so teams share no credential and revoking one
 * leaves the others untouched.
 *
 * IDEMPOTENT: a re-join of the same host converges — the existing `HostRecord`
 * is UPDATED, its attached projects preserved, never duplicated.
 */
import os from 'node:os';

import { isGroveEraId } from '@myco/grove/ids.js';
import { getMachineId } from '../machine-id.js';
import { parseHostUrl, probeHostReachability } from './host-url.js';

import {
  ENROLLMENT_RETRY_BACKOFFS_MS,
  HOST_BEARER_SECRET,
  HOST_ENROLL_ROUTE,
  HOST_MIN_COMPAT_VERSION,
  HOST_RESIGN_ROUTE,
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_CONNECT_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
} from '../constants.js';
import {
  withHostOperationLock,
  type HostOperationLease,
} from './operation-lock.js';
import { assertValidSecretEntry, InvalidSecretValueError } from '@myco/config/secrets.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { codedMembershipError, membershipErrorCode } from './membership-error.js';
import { listResidencyJournals } from './residency-journal.js';
import {
  abandonHostEnrollment,
  advanceHostEnrollmentPhase,
  HostJoinStateCorruptError,
  inspectHostMembershipForLeave,
  persistEnrollmentMembership,
  readHostRegistry,
  readHostSecrets,
  reserveHostEnrollment,
  retireHostMembership,
} from '@myco/host/registry.js';

// ---------------------------------------------------------------------------
// Enrollment seam
// ---------------------------------------------------------------------------

/** What the host tells a member at enrollment: its identity, its overlay address
 *  (100.64 IP + daemon port), the shared serve-bearer, and its wire version. */
export interface HostEnrollment {
  host_id: string;
  label: string;
  protocol_version: number;
  /** The shared host serve-bearer, stored under {@link HOST_BEARER_SECRET}. */
  bearer: string;
  /** The host's self-reported served Grove. `undefined` means the response
   *  omitted `served_grove_id`; `null` means the host explicitly has no
   *  designation. Join persists it for `attachCommand` to use as the Grove
   *  source for a new attach ref. */
  served_grove_id?: string | null;
  enrollment_receipt?: {
    enrollment_nonce: string;
    host_id: string;
    protocol_version: number;
  };
}

export interface EnrollmentResult extends HostEnrollment {
  projects?: unknown;
}

/** Everything the enrollment step knows after the overlay join. */
export interface EnrollmentContext {
  /** The canonical host_id being joined (`--host-id` ?? the `<host>` positional). */
  hostId: string;
  /** The `<host>` positional as typed. */
  hostRef: string;
  /** The one-time key the operator passed (single-use, daemon-validated). */
  oneTimeKey: string;
  /** The host's public URL to dial for enrollment — a NON-SECRET the operator
   *  hands the joiner alongside the one-time key. The SECRET token comes back
   *  in the enrollment response, never out-of-band. */
  hostUrl?: string;
  /** This machine's id, asserted at enrollment. The host binds the issued token
   *  to it, so it becomes the trust-on-first-use anchor every later request is
   *  checked against — not a per-request claim. */
  machineId: string;
  /** This member's hostname, for the operator's member list. Non-secret. */
  memberHostname?: string;
  /** Stable, durable request correlation for repeatable enrollment. */
  enrollmentNonce?: string;
  // --- manual enrollment context ---
  bearer?: string;
  protocolVersion?: number;
  label?: string;
}

export interface EnrollmentClient {
  /** Obtain the host serve-bearer + overlay address over the overlay. */
  enroll(ctx: EnrollmentContext): Promise<EnrollmentResult>;
}

/** The wire response the host enrollment endpoint returns. */
interface HostEnrollmentResponse {
  host_id: string;
  label: string;
  protocol_version: number;
  bearer: string;
  served_grove_id?: string | null;
  enrollment_receipt?: {
    enrollment_nonce: string;
    host_id: string;
    protocol_version: number;
  };
}

function enrollmentFailure(message: string): Error {
  return codedMembershipError('host_enroll_failed', message);
}

function requiredEnrollmentString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw enrollmentFailure(`Host enrollment response has an invalid ${field}.`);
  }
  return candidate;
}

function enrollmentIdentity(
  value: Record<string, unknown>,
  field: 'host_id' | 'label',
  fallback: string,
): string {
  const candidate = value[field];
  if (candidate === undefined || (typeof candidate === 'string' && candidate.trim().length === 0)) {
    return fallback;
  }
  if (typeof candidate !== 'string') {
    throw enrollmentFailure(`Host enrollment response has an invalid ${field}.`);
  }
  return candidate;
}


/** Validate all wire values before they reach enrollment, reachability, or disk. */
function parseEnrollmentResponse(
  value: unknown,
  identityFallback: { hostId: string; label: string; enrollmentNonce?: string },
): HostEnrollmentResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw enrollmentFailure('Host enrollment returned a response Myco could not read.');
  }
  const response = value as Record<string, unknown>;
  if (Object.hasOwn(response, 'projects')
    && (!Array.isArray(response.projects) || response.projects.length !== 0)) {
    throw enrollmentFailure('Host enrollment cannot assign project attachments.');
  }

  const bearer = requiredEnrollmentString(response, 'bearer');
  try {
    assertValidSecretEntry(HOST_BEARER_SECRET, bearer);
  } catch (error) {
    if (!(error instanceof InvalidSecretValueError)) throw error;
    throw enrollmentFailure('Host enrollment response has an invalid bearer.');
  }

  const protocolVersion = response.protocol_version;
  if (typeof protocolVersion !== 'number'
    || !Number.isSafeInteger(protocolVersion)
    || protocolVersion < HOST_MIN_COMPAT_VERSION
    || protocolVersion > HOST_PROTOCOL_VERSION) {
    throw enrollmentFailure('Host enrollment response has an invalid protocol_version.');
  }

  const servedGroveId = response.served_grove_id;
  if (servedGroveId !== undefined && servedGroveId !== null
    && (typeof servedGroveId !== 'string' || !isGroveEraId(servedGroveId, 'grove'))) {
    throw enrollmentFailure('Host enrollment response has an invalid served_grove_id.');
  }

  const hostId = enrollmentIdentity(response, 'host_id', identityFallback.hostId);
  let enrollmentReceipt: HostEnrollmentResponse['enrollment_receipt'];
  if (response.enrollment_receipt !== undefined) {
    const receipt = response.enrollment_receipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw enrollmentFailure('Host enrollment response has an invalid enrollment_receipt.');
    }
    const fields = receipt as Record<string, unknown>;
    if (typeof fields.enrollment_nonce !== 'string'
      || fields.enrollment_nonce !== identityFallback.enrollmentNonce
      || fields.host_id !== hostId
      || fields.protocol_version !== protocolVersion) {
      throw enrollmentFailure('Host enrollment response has a mismatched enrollment_receipt.');
    }
    enrollmentReceipt = {
      enrollment_nonce: fields.enrollment_nonce,
      host_id: fields.host_id,
      protocol_version: fields.protocol_version,
    };
  }

  return {
    host_id: hostId,
    label: enrollmentIdentity(response, 'label', identityFallback.label),
    protocol_version: protocolVersion,
    bearer,
    ...(Object.hasOwn(response, 'served_grove_id')
      ? { served_grove_id: servedGroveId as string | null }
      : {}),
    ...(enrollmentReceipt ? { enrollment_receipt: enrollmentReceipt } : {}),
  };
}

function validateEnrollment(
  enrollment: EnrollmentResult,
  identityFallback: { hostId: string; label: string; enrollmentNonce?: string },
): EnrollmentResult {
  return parseEnrollmentResponse(enrollment, identityFallback);
}

/** How the real client puts an enrollment request on the wire. Injectable so a
 *  test can drive a fixture host. Returns the raw status + body so the client
 *  owns parsing + the version-skew (409) mapping. */
export type EnrollmentTransport = (input: {
  hostUrl: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number; body: string }>;

/**
 * The default enrollment transport: one HTTPS POST to the host's public URL.
 *
 * No tunnel, no local proxy, no per-host process — the whole reason the member
 * side got simpler. The request carries the one-time join key and this
 * machine's id; the response carries this member's own token.
 */
export const defaultEnrollmentTransport: EnrollmentTransport = async (input) => {
  const https = await import('node:https');
  const { hostname, port } = parseHostUrl(input.hostUrl);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let responded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Clearing the deadline is tied to SETTLING, never to an intermediate
    // milestone — see the timer's own comment for the hang that caused.
    const settle = (): void => {
      settled = true;
      if (timer) clearTimeout(timer);
    };
    const succeed = (value: { status: number; body: string }): void => {
      if (settled) return;
      settle();
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settle();
      reject(error);
    };

    const req = https.request({
      protocol: 'https:',
      hostname,
      port,
      method: 'POST',
      // Origin-form by construction — `path` is a constant here, and the dial
      // seam refuses anything else for the reason recorded in `defaultDial`.
      path: input.path,
      headers: { ...input.headers, 'content-length': Buffer.byteLength(input.body) },
    }, (res) => {
      responded = true;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => succeed({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      // A connection that dies MID-body: `req`'s `'close'` can no longer be the
      // signal (see below), so the response stream carries it instead.
      res.once('aborted', () => fail(new Error('enrollment connection closed before the response completed')));
      res.once('error', fail);
    });
    // Settle on every path, and settle ONCE.
    //
    // `destroy(err)` emits no `'error'` under Bun, so the timeout rejects
    // itself. The subtler half: `req`'s `'close'` is NOT a lost-connection
    // signal on either runtime. Node fires it after a completed response; Bun
    // fires it BEFORE the response body's `'end'`. Rejecting there
    // unconditionally fails every enrollment on the runtime Myco ships —
    // including ones the host answered 200, which burns the single-use key and
    // leaves a member the user can never authenticate as. So `'close'` only
    // means failure when no response ever arrived; a response that starts and
    // then dies is `res`'s `'aborted'`, and the timer backstops both.
    //
    // The deadline covers the WHOLE request, not just the headers. Cancelling
    // it when the response STARTS leaves a peer that sends a status line and
    // headers, writes a partial body, and then simply holds the socket open
    // with no bound at all: `'end'` never comes, `'aborted'` never fires, and
    // `'close'` is guarded by `responded`. That hangs forever — on Node too,
    // so it is a design bug and not a runtime quirk — and a hung `myco join`
    // never runs its own cleanup. A stalled Funnel backend or a host wedged
    // mid-response produces exactly that shape.
    timer = setTimeout(() => {
      fail(new Error('enrollment request timed out'));
      req.destroy();
    }, HOST_PROXY_HEADERS_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    req.once('error', fail);
    req.once('close', () => {
      if (!responded) fail(new Error('enrollment connection closed before a response'));
    });
    req.write(input.body);
    req.end();
  });
};

/** The default enrollment client used by `join` unless a caller injects one. */
export function createEnrollmentClient(transport: EnrollmentTransport = defaultEnrollmentTransport): EnrollmentClient {
  return {
    async enroll(ctx: EnrollmentContext): Promise<EnrollmentResult> {
      if (!ctx.hostUrl) {
        throw enrollmentFailure('Joining a host needs its public address (--host-url).');
      }
      const body = JSON.stringify({
        key: ctx.oneTimeKey,
        machine_id: ctx.machineId,
        member_hostname: ctx.memberHostname,
        ...(ctx.enrollmentNonce ? { enrollment_nonce: ctx.enrollmentNonce } : {}),
      });
      const response = await transport({
        hostUrl: ctx.hostUrl,
        path: HOST_ENROLL_ROUTE,
        headers: {
          'content-type': 'application/json',
          [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
        },
        body,
      });

      if (response.status === 401) {
        // Non-retryable: the key is single-use and expiring, so a refusal will
        // refuse identically next time. Retrying would only burn the backoff.
        throw codedMembershipError(
          'host_enroll_rejected',
          'The host refused this join key — it may be expired, already used, or revoked. Ask the host operator for a new one.',
        );
      }
      if (response.status === 409) {
        // 409 carries TWO distinct refusals, and telling a user to update Myco
        // when the real problem is that their machine already has access sends
        // them down a road with no fix at the end of it.
        if (readRefusalCode(response.body) === 'machine_already_enrolled') {
          throw codedMembershipError(
            'machine_already_enrolled',
            'This machine already has access to that host. Ask the host operator to revoke it first, then join again.',
          );
        }
        throw codedMembershipError(
          'protocol_mismatch',
          'This machine and the host are running different Myco versions — update both to the same release, then join again.',
        );
      }
      if (response.status !== 200) {
        throw enrollmentFailure(`Host enrollment failed with HTTP ${response.status}.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw enrollmentFailure('Host enrollment returned a response Myco could not read.');
      }
      return validateEnrollment(parsed as EnrollmentResult, {
        hostId: ctx.hostId,
        label: ctx.label ?? ctx.hostRef,
        enrollmentNonce: ctx.enrollmentNonce,
      });
    },
  };
}

export const realEnrollmentClient: EnrollmentClient = createEnrollmentClient();

/** Default backoff wait — a plain `setTimeout` wrapped as a Promise. Tests inject
 *  `deps.sleep` so retry backoff never costs real wall-clock time. */
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The `error` field of a refusal body, when it has one. Best-effort: a refusal
 *  that is not JSON is still a refusal, it just carries no discriminator. */
function readRefusalCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

/** Refusals the HOST decided. Retrying one re-asks a settled question. */
const NON_RETRYABLE_ENROLLMENT_CODES = new Set<string>([
  'host_enroll_rejected',
  'protocol_mismatch',
  'machine_already_enrolled',
]);

/**
 * Bounded retry-with-backoff around a single {@link EnrollmentClient.enroll} call
 * — only the transport call is retried, nothing before or after it in
 * `joinHost`. {@link ENROLLMENT_RETRY_BACKOFFS_MS} bounds it at 3
 * attempts total (2s then 4s between them, none before the first or after the
 * last); the final attempt's failure is rethrown UNCHANGED so the caller sees the
 * same error a non-retrying `enroll` would have thrown.
 */
async function enrollWithRetry(
  client: EnrollmentClient,
  ctx: EnrollmentContext,
  sleep: (ms: number) => Promise<void>,
  log: (message: string) => void,
): Promise<EnrollmentResult> {
  const backoffs = ENROLLMENT_RETRY_BACKOFFS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.enroll(ctx);
    } catch (err) {
      // A DECIDED refusal is not a transport hiccup. The host answered, and it
      // will answer identically next time: a spent or expired key stays spent,
      // a version mismatch stays mismatched, an already-enrolled machine stays
      // enrolled. Retrying only makes the user wait 6s for the same answer and
      // re-POSTs a spent key twice.
      if (NON_RETRYABLE_ENROLLMENT_CODES.has(membershipErrorCode(err) ?? '')) throw err;
      if (attempt >= backoffs.length) throw err;
      const delayMs = backoffs[attempt]!;
      log(`Enrollment attempt ${attempt + 1} failed (${(err as Error).message}) — retrying in ${delayMs}ms…`);
      await sleep(delayMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Options / deps / result
// ---------------------------------------------------------------------------

export interface JoinOptions {
  /** The `<host>` positional — a host_id (matches the affiliation hint's
   *  `myco join <host_id>`). */
  hostRef: string;
  /** The host's public URL, handed to the joiner alongside the key. A
   *  NON-secret: it is the address, not the credential. */
  hostUrl?: string;
  /** The one-time key the host operator minted (single-use). */
  key: string;
  /** Canonical host_id override (when the positional is not itself the id). */
  hostId?: string;
  bearer?: string;
  protocolVersion?: number;
  label?: string;
}

export interface MemberOverlayDeps {
  platform?: NodeJS.Platform;
  enrollmentClient?: EnrollmentClient;
  /** Test seam for the leave-side resign call, which goes over the wire
   *  directly rather than through {@link EnrollmentClient}. */
  enrollmentTransport?: EnrollmentTransport;
  /** Test seam: this machine's id (production reads the real one). */
  machineId?: string;
  /** Override the team home the residency-journal gate reads (tests). */
  teamsHome?: string;
  /** Backoff wait between enrollment retry attempts (tests inject a no-real-wait
   *  fake). Default a plain `setTimeout` wrapped as a Promise. */
  sleep?: (ms: number) => Promise<void>;
  logger?: (message: string) => void;
  lockNamespace?: PerUserLockNamespace;
}

export interface JoinResult {
  hostId: string;
  hostUrl: string;
  hostReachable: boolean;
  /** True when this join created the record; false when it converged an existing one. */
  created: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

/**
 * Join a team host: spend a one-time key at its public URL, and record what
 * comes back.
 *
 * The whole operation is one HTTPS round trip plus a registry write. There is
 * no network to stand up, no local process per host, and nothing to provision:
 * the host's URL is already reachable.
 *
 * ATOMIC. The membership is committed under a reserved generation
 * (`reserveHostEnrollment` → `persistEnrollmentMembership`), so a crash
 * mid-join leaves either the previous membership or none — never a record
 * whose token and address came from different attempts. A re-join replaces the
 * record and preserves its attached projects.
 */
export async function joinHost(options: JoinOptions, deps: MemberOverlayDeps = {}): Promise<JoinResult> {
  const log = deps.logger ?? ((m: string) => console.log(m));
  const hostRef = options.hostRef?.trim();
  if (!hostRef) throw new Error('join requires a <host> — the host_id the operator gave you.');
  if (!options.key?.trim()) {
    throw codedMembershipError('host_enroll_failed', 'join requires the one-time key the host operator minted.');
  }
  const hostUrl = options.hostUrl?.trim();
  if (!hostUrl) {
    throw codedMembershipError(
      'host_enroll_failed',
      'join requires the host\'s public address (--host-url) — the operator shares it alongside the key.',
    );
  }
  // Refuse an unusable address HERE rather than writing a record that can only
  // fail later: every drain and probe downstream treats a record as a live
  // target, so a bad address is worse than no membership.
  try {
    parseHostUrl(hostUrl);
  } catch (err) {
    throw codedMembershipError('host_enroll_failed', (err as Error).message);
  }

  const hostId = options.hostId?.trim() || hostRef;
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const machineId = deps.machineId ?? getMachineId();

  let reservation: ReturnType<typeof reserveHostEnrollment>;
  try {
    reservation = reserveHostEnrollment(hostId, lockNamespace);
  } catch (err) {
    // A crashed pre-1.4.0 join leaves a retired-phase enrollment intent that no
    // longer parses; `reserveHostEnrollment` throws before any network call. Map
    // it to a coded error that names the fix, rather than surfacing the raw
    // internal message with no way forward.
    if (err instanceof HostJoinStateCorruptError) {
      throw codedMembershipError(
        'host_join_state_corrupt',
        `This machine's saved join state for ${hostRef} is corrupt — often left by a Myco that `
          + `crashed mid-join. Run \`myco leave ${hostRef}\` to clear it, then join again.`,
      );
    }
    throw err;
  }
  try {
    const client = deps.enrollmentClient ?? realEnrollmentClient;
    log(`Enrolling with ${hostUrl}…`);
    const enrollment = await enrollWithRetry(
      client,
      {
        hostId,
        hostRef,
        oneTimeKey: options.key.trim(),
        hostUrl,
        machineId,
        memberHostname: os.hostname(),
        enrollmentNonce: reservation.enrollmentNonce,
        label: options.label,
      },
      deps.sleep ?? defaultSleep,
      log,
    );

    const staged = advanceHostEnrollmentPhase(reservation, 'enrolling', lockNamespace);
    const result = persistEnrollmentMembership(
      {
        host_id: enrollment.host_id,
        label: enrollment.label,
        host_url: hostUrl,
        protocol_version: enrollment.protocol_version,
        created_at: new Date().toISOString(),
        ...(Object.hasOwn(enrollment, 'served_grove_id')
          ? { served_grove_id: enrollment.served_grove_id }
          : {}),
      },
      enrollment.bearer,
      staged,
      lockNamespace,
    );
    log(`${result.created ? 'Joined' : 'Re-joined'} ${result.record.host_id}.`);

    const reachability = await probeHostReachability(hostUrl);
    return {
      hostId: result.record.host_id,
      hostUrl,
      hostReachable: reachability.state === 'reachable',
      created: result.created,
      notes: reachability.state === 'reachable' ? [] : [reachability.detail],
    };
  } catch (err) {
    // Discard the reservation so a failed join does not fence the next attempt
    // behind a generation nothing committed. Only eligible states are
    // discarded — `abandonHostEnrollment` refuses once a credential is staged,
    // because that one may already be committed.
    try { abandonHostEnrollment(reservation, lockNamespace); } catch { /* left for a later converge */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// leave
// ---------------------------------------------------------------------------

export interface LeaveResult {
  removed: boolean;
  notes: string[];
}

/**
 * Detach this machine from a host: remove its HostRecord, bearer, and attach
 * refs. Every OTHER joined host is untouched. An interrupted pre-enrollment
 * join is also removed when its durable host directory remains. Idempotent: a
 * host with no state is a no-op.
 */
export async function leaveHost(hostRef: string, deps: MemberOverlayDeps = {}): Promise<LeaveResult> {
  if (!hostRef?.trim()) throw new Error('leave requires a <host> — the host_id to detach from.');
  const hostId = hostRef.trim();
  return withHostOperationLock(
    hostId,
    'leave',
    (lease) => leaveHostLocked(hostId, deps, lease),
    deps.lockNamespace ?? nativePerUserLockNamespace,
  );
}

/**
 * Surrender this machine's access on the host, so leaving releases the host's
 * record instead of orphaning it. Returns whether the host confirmed.
 *
 * Never throws: every failure mode here (host down, URL stale, token already
 * revoked, no bearer on record) must still permit the local leave.
 */
async function resignFromHost(
  hostId: string,
  deps: MemberOverlayDeps,
  lockNamespace: PerUserLockNamespace,
): Promise<boolean> {
  try {
    const record = readHostRegistry(lockNamespace).find((r) => r.host_id === hostId);
    const hostUrl = record?.host_url;
    if (!hostUrl) return false;
    const bearer = readHostSecrets(hostId, lockNamespace)[HOST_BEARER_SECRET];
    if (!bearer) return false;

    const transport = deps.enrollmentTransport ?? defaultEnrollmentTransport;
    const response = await transport({
      hostUrl,
      path: HOST_RESIGN_ROUTE,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION),
      },
      body: '{}',
    });
    // A 401 means the host already considers this member gone, which is the
    // outcome we wanted — treat it as success rather than warning about a
    // record that no longer exists.
    return response.status === 200 || response.status === 401;
  } catch {
    return false;
  }
}

async function leaveHostLocked(
  hostId: string,
  deps: MemberOverlayDeps,
  lease: HostOperationLease,
): Promise<LeaveResult> {
  const log = deps.logger ?? ((m: string) => console.log(m));
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const notes: string[] = [];

  const inspection = inspectHostMembershipForLeave(hostId, lease, lockNamespace);
  if (!inspection.statePresent) {
    log(`Not joined to host ${hostId} — nothing to remove.`);
    return { removed: false, notes };
  }

  // Leaving destroys the bearer and every attach ref for this host, and the
  // bearer is unrecoverable — re-joining mints a new generation. So a leave
  // while projects are still attached (or mid-move) would leave them
  // registered nowhere, with capture diverting to a Grove that no longer
  // exists locally. Refuse until the projects are detached and no move is in
  // flight. Placed AFTER the nothing-to-remove no-op so a journal naming an
  // already-gone host (partial teardown) keeps the documented idempotent
  // return instead of turning into a refusal.
  const attachedProjects = inspection.record?.projects ?? [];
  if (attachedProjects.length > 0) {
    throw codedMembershipError(
      'leave_projects_attached',
      `Cannot leave host ${hostId}: ${attachedProjects.length} project(s) are still attached through it. `
      + 'Detach each project first (`myco detach`), then leave.',
    );
  }
  const inFlight = listResidencyJournals(deps.teamsHome)
    .filter((journal) => journal.host_id === hostId && journal.phase !== 'done');
  if (inFlight.length > 0) {
    throw codedMembershipError(
      'leave_transition_in_flight',
      `Cannot leave host ${hostId}: a project move involving this host is still in progress `
      + `("${inFlight[0]!.project_name}"). Wait for it to finish, then leave.`,
    );
  }

  // TELL THE HOST FIRST, best-effort. A host that is never told keeps a LIVE
  // record for a machine that has gone, and that machine's next join is refused
  // as already-enrolled — recoverable only by an operator, possibly on a
  // machine the departing member cannot reach.
  //
  // Best-effort by design. A host that is down, unreachable, or already
  // revoked this member must not be able to trap it in the membership: the
  // local retirement below is what `leave` actually promises. A failure here
  // becomes a NOTE so the user can tell the operator, never an exception.
  const resigned = await resignFromHost(hostId, deps, lockNamespace);
  if (resigned) {
    log(`Released this machine's access on ${hostId}.`);
  } else {
    notes.push(
      `Could not tell ${hostId} this machine left, so the host may still list it. `
      + 'If re-joining is refused as already having access, ask the host operator to remove it.',
    );
  }

  // Otherwise leaving is a registry write and nothing else — no process to
  // stop, no port to release, and nothing whose identity could drift from what
  // the registry says.
  retireHostMembership(hostId, lease, lockNamespace);
  log(`Removed host record + bearer for ${hostId}.`);

  const remaining = readHostRegistry(lockNamespace).length;
  if (remaining > 0) log(`${remaining} other host(s) still joined — their membership is untouched.`);

  return { removed: true, notes };
}

