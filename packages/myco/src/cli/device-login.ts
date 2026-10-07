import type { ExchangeResult, JoinAnswer } from '../member/join-code.js';

const REQUEST_TIMEOUT_MS = 30_000;
const SLOW_DOWN_SECONDS = 5;
const MAX_DEVICE_LIFETIME_SECONDS = 15 * 60;

class DeviceLoginFailure extends Error {
  constructor(readonly code: 'unreachable' | 'unreadable', message: string) { super(message); }
}

/** Device secrets travel only in POST bodies. Only the human code and the verification address are printed. */
export async function deviceLogin(serverUrl: string, machine: { machineId: string; machineName: string; os: string }, deps: {
  fetch?: typeof fetch; stdout: (line: string) => void; sleep?: (ms: number) => Promise<void>; clock?: () => number;
}): Promise<ExchangeResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const clock = deps.clock ?? Date.now;
  const failure = (code: string, reason: string): ExchangeResult => ({ ok: false, code, reason });
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetchImpl(`${serverUrl}${path}`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new DeviceLoginFailure('unreachable', 'could not complete sign-in with the Deployment');
    }
    let answer: unknown;
    try { answer = await response.json(); }
    catch { throw new DeviceLoginFailure('unreadable', 'the Deployment answered with an unreadable sign-in reply'); }
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
      throw new DeviceLoginFailure('unreadable', 'the Deployment answered with an unreadable sign-in reply');
    }
    return { response, answer: answer as Record<string, unknown> };
  };
  try {
    const started = await post('/auth/device/start', machine);
    const { device_code: deviceCode, user_code: userCode, expires_in: expiresIn, interval: initialInterval } = started.answer;
    if (!started.response.ok) return failure('refused', 'the Deployment refused to start sign-in');
    if (typeof deviceCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(deviceCode)
      || typeof userCode !== 'string' || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(userCode)
      || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_DEVICE_LIFETIME_SECONDS
      || typeof initialInterval !== 'number' || !Number.isFinite(initialInterval) || initialInterval < 1 || initialInterval > expiresIn) {
      return failure('unreadable', 'the Deployment answered with an unreadable sign-in request');
    }
    // Verification always stays on the Deployment the user named.
    deps.stdout(`Open ${serverUrl}/device?code=${userCode} on a machine signed in to the dashboard.`);
    deps.stdout(`Code: ${userCode}`);
    deps.stdout('Check the machine details and approve it there. Waiting for approval…');
    const deadline = clock() + expiresIn * 1000;
    let interval = initialInterval;
    while (clock() < deadline) {
      await sleep(interval * 1000);
      if (clock() >= deadline) break;
      const { response, answer } = await post('/auth/device/poll', { device_code: deviceCode });
      if (response.status === 429) { interval += SLOW_DOWN_SECONDS; continue; }
      if (answer.error === 'authorization_pending') continue;
      if (answer.error === 'slow_down') {
        interval = Math.max(interval + SLOW_DOWN_SECONDS, typeof answer.interval === 'number' && Number.isFinite(answer.interval) ? answer.interval : 0);
        continue;
      }
      if (response.ok && answer.joined === true && typeof answer.memberId === 'string' && typeof answer.token === 'string'
        && typeof answer.tokenId === 'string' && typeof answer.expiresAt === 'number' && Number.isFinite(answer.expiresAt)
        && (answer.role === 'member' || answer.role === 'admin') && (answer.projectId === null || typeof answer.projectId === 'string')) {
        return { ok: true, answer: answer as unknown as JoinAnswer };
      }
      const reason = answer.error === 'access_denied' ? 'sign-in was denied in the dashboard'
        : answer.error === 'expired_token' ? 'sign-in expired; run myco login again'
        : answer.error === 'identity_claimed' ? 'this machine belongs to another member'
        : 'the Deployment refused this sign-in; run myco login again';
      const code = ['access_denied', 'expired_token', 'identity_claimed', 'invalid_grant'].includes(String(answer.error)) ? String(answer.error) : 'refused';
      return failure(code, reason);
    }
    return failure('expired_token', 'sign-in expired; run myco login again');
  } catch (error) {
    if (error instanceof DeviceLoginFailure) return failure(error.code, error.message);
    throw error;
  }
}
