/**
 * Which port a runtime serves.
 *
 * The Cloudflare probe-and-hold contract talks to a runtime on the container
 * port, so a runtime handed nothing has to keep serving it. A runtime the
 * self-hosted supervisor starts shares one namespace with its siblings and
 * serves no listener at all, and this is the only place that word is decided.
 */
import { describe, expect, it } from 'bun:test';
import { NO_RUNTIME_LISTENER, RUNTIME_PROBE_PORT, runtimePortFrom } from '@myco/agent/runtime/runtime-port.js';

describe('the runtime port', () => {
  it('is the container port when the dispatch names none', () => {
    expect(RUNTIME_PROBE_PORT).toBe(8080);
    expect(runtimePortFrom(undefined)).toBe(RUNTIME_PROBE_PORT);
    expect(runtimePortFrom('')).toBe(RUNTIME_PROBE_PORT);
  });

  it('is no listener at all for the word the supervisor sets', () => {
    expect(NO_RUNTIME_LISTENER).toBe('none');
    expect(runtimePortFrom(NO_RUNTIME_LISTENER)).toBeNull();
  });

  it('is the port a dispatch names, zero being an ephemeral port rather than a way to spell no listener', () => {
    expect(runtimePortFrom('9099')).toBe(9099);
    expect(runtimePortFrom('0')).toBe(0);
    expect(runtimePortFrom('65535')).toBe(65_535);
  });

  it('refuses a value that is neither, rather than binding the container port under it', () => {
    for (const value of ['off', 'null', '-1', '65536', '8080.5', 'eight']) {
      expect(() => runtimePortFrom(value)).toThrow(/MYCO_RUNTIME_PORT/);
    }
  });
});
