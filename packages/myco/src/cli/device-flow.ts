import { START_SLOW_DOWN } from '@goondocks/myco-shared/setup-guidance';

const REQUEST_TIMEOUT_MS = 30_000;
const SLOW_DOWN_SECONDS = 5;
const MAX_TRANSIENT_POLL_FAILURES = 1;
const MAX_DEVICE_LIFETIME_SECONDS = 15 * 60;
const MS_PER_SECOND = 1000;
const DEVICE_SECRET = /^[A-Za-z0-9_-]{43}$/;
const USER_CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

class DeviceFlowFailure extends Error {
  constructor(readonly code: 'unreachable' | 'unreadable', message: string) { super(message); }
}

export type DeviceFlowResult<T> = { ok: true; answer: T } | { ok: false; code: string; reason: string };

/** What one kind of device approval says to the Deployment and to the person waiting. */
export interface DeviceFlowSpec<T> {
  /** What the approval is called in the messages a person reads: "sign-in", "registration". */
  noun: string;
  startPath: string;
  pollPath: string;
  /** The lines shown once the approval is open. */
  announce: (userCode: string) => readonly string[];
  /** The poll answer that completes the approval, or null for any other. */
  accept: (response: Response, answer: Record<string, unknown>) => T | null;
  /** The poll errors the person is told about by name, each with its words. */
  refusals: Readonly<Record<string, string>>;
  /** Named failures when opening the approval. */
  startRefusals: Readonly<Record<string, string>>;
  /** Words for a poll error not named in `refusals`. */
  otherRefusal: string;
}

/** An open approval: the secret it is polled on, the code a person reads, and when it lapses on this machine's clock. */
export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  intervalSeconds: number;
}

export interface DeviceFlowDeps {
  fetch?: typeof fetch;
  stdout: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export interface DeviceFlowHooks {
  /** Called with the grant before it is shown or polled, so a caller can keep it. */
  onStarted?: (grant: DeviceGrant) => void;
  /** Poll a grant opened earlier instead of starting one. */
  resume?: DeviceGrant;
}

/**
 * Run a device approval: open it (or resume one), show where to approve, and
 * poll until it is approved, refused or lapsed. Device secrets travel only in
 * POST bodies; only the human code and the verification address are printed.
 */
export async function runDeviceFlow<T>(serverUrl: string, spec: DeviceFlowSpec<T>, startBody: unknown, deps: DeviceFlowDeps, hooks: DeviceFlowHooks = {}): Promise<DeviceFlowResult<T>> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const clock = deps.clock ?? Date.now;
  const failure = (code: string, reason: string): DeviceFlowResult<T> => ({ ok: false, code, reason });
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetchImpl(`${serverUrl}${path}`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new DeviceFlowFailure('unreachable', `could not complete ${spec.noun} with the Deployment`);
    }
    if (response.status >= 500) throw new DeviceFlowFailure('unreachable', `could not complete ${spec.noun} with the Deployment`);
    let answer: unknown;
    try { answer = await response.json(); }
    catch { throw new DeviceFlowFailure('unreadable', `the Deployment answered with an unreadable ${spec.noun} reply`); }
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
      throw new DeviceFlowFailure('unreadable', `the Deployment answered with an unreadable ${spec.noun} reply`);
    }
    return { response, answer: answer as Record<string, unknown> };
  };
  try {
    let grant = hooks.resume;
    if (grant === undefined) {
      const started = await post(spec.startPath, startBody);
      const { device_code: deviceCode, user_code: userCode, expires_in: expiresIn, interval: initialInterval } = started.answer;
      if (!started.response.ok) {
        const code = started.answer.error;
        if (typeof code === 'string' && Object.hasOwn(spec.startRefusals, code)) return failure(code, spec.startRefusals[code]!);
        if (started.response.status === 429) return failure('slow_down', START_SLOW_DOWN);
        return failure('refused', `the Deployment refused to start ${spec.noun}`);
      }
      if (typeof deviceCode !== 'string' || !DEVICE_SECRET.test(deviceCode)
        || typeof userCode !== 'string' || !USER_CODE.test(userCode)
        || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_DEVICE_LIFETIME_SECONDS
        || typeof initialInterval !== 'number' || !Number.isFinite(initialInterval) || initialInterval < 1 || initialInterval > expiresIn) {
        return failure('unreadable', `the Deployment answered with an unreadable ${spec.noun} request`);
      }
      grant = { deviceCode, userCode, expiresAt: clock() + expiresIn * MS_PER_SECOND, intervalSeconds: initialInterval };
      hooks.onStarted?.(grant);
    }
    // Verification always stays on the Deployment the user named.
    for (const line of spec.announce(grant.userCode)) deps.stdout(line);
    const deadline = grant.expiresAt;
    let interval = grant.intervalSeconds;
    let transientFailures = 0;
    while (clock() < deadline) {
      await sleep(interval * MS_PER_SECOND);
      if (clock() >= deadline) break;
      let reply: Awaited<ReturnType<typeof post>>;
      try { reply = await post(spec.pollPath, { device_code: grant.deviceCode }); }
      catch (error) {
        if (!(error instanceof DeviceFlowFailure) || error.code !== 'unreachable' || transientFailures >= MAX_TRANSIENT_POLL_FAILURES) throw error;
        transientFailures++;
        interval += SLOW_DOWN_SECONDS;
        continue;
      }
      const { response, answer } = reply;
      if (response.status === 429) { interval += SLOW_DOWN_SECONDS; continue; }
      if (answer.error === 'authorization_pending') continue;
      if (answer.error === 'slow_down') {
        interval = Math.max(interval + SLOW_DOWN_SECONDS, typeof answer.interval === 'number' && Number.isFinite(answer.interval) ? answer.interval : 0);
        continue;
      }
      const accepted = spec.accept(response, answer);
      if (accepted !== null) return { ok: true, answer: accepted };
      const named = typeof answer.error === 'string' && Object.hasOwn(spec.refusals, answer.error) ? answer.error : null;
      return failure(named ?? 'refused', named === null ? spec.otherRefusal : spec.refusals[named]!);
    }
    return failure('expired_token', spec.refusals.expired_token ?? spec.otherRefusal);
  } catch (error) {
    if (error instanceof DeviceFlowFailure) return failure(error.code, error.message);
    throw error;
  }
}
