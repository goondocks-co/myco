import { describe, expect, it } from 'bun:test';
import { ApiError, SignedOutError } from '../../packages/myco-server/ui/src/lib/api';
import { shouldRetry } from '../../packages/myco-server/ui/src/lib/query-client';

describe('dashboard query retry', () => {
  it('keeps the status, the server\'s error code and the body, and never carries the server\'s sentence as its message', () => {
    const body = { error: 'bad_request', reason: 'The backup exceeds the supported size.' };
    const error = new ApiError(400, body);
    expect({ message: error.message, code: error.code, status: error.status }).toEqual({ message: 'server answered 400', code: 'bad_request', status: 400 });
    expect(error.body).toBe(body);
    expect(new ApiError(409, { message: 'Update the Deployment first.' }).message).toBe('server answered 409');
    for (const raw of [null, '<html>proxy error</html>', { error: 123 }, { error: ' ' }]) {
      expect({ message: new ApiError(503, raw).message, code: new ApiError(503, raw).code }).toEqual({ message: 'server answered 503', code: undefined });
    }
  });

  it('never asks again after a 4xx — a missing session, a refusal, a signed-out visitor', () => {
    expect(shouldRetry(0, new ApiError(404, { error: 'not_found' }))).toBe(false);
    expect(shouldRetry(0, new ApiError(403, null))).toBe(false);
    expect(shouldRetry(0, new SignedOutError())).toBe(false);
  });

  it('asks twice more after a 5xx or a connection that never answered', () => {
    expect(shouldRetry(0, new ApiError(503, null))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, null))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, null))).toBe(false);
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(2, new TypeError('Failed to fetch'))).toBe(false);
  });
});
