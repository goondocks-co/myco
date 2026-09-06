/**
 * A stand-in for an adapter a deployment has not configured. It throws by name on
 * use rather than returning a silent no-op: an unconfigured capability must be a
 * loud failure, never data quietly going nowhere.
 */
export function notConfigured<T extends object>(adapter: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      // Properties the runtime looks up implicitly are left undefined. Trapping
      // them makes an `await` of the object throw, makes it masquerade as a
      // thenable, and makes `JSON.stringify` throw — which would defeat the
      // last-resort error handler that serialises what it is given.
      if (prop === 'then' || prop === 'toJSON' || prop === 'toString' || prop === 'inspect' || typeof prop === 'symbol') return undefined;
      return () => {
        throw new Error(`${adapter} adapter is not configured on this deployment (called ${String(prop)})`);
      };
    },
  });
}

