import { expect } from 'bun:test';

/** A run refusal names its cause and the next corrective call. */
export function expectRunRefusal(
  value: unknown,
  cause: string | readonly string[],
  next: { tool: string; op: string; [argument: string]: unknown },
): void {
  if (value === null || typeof value !== 'object' || !('ok' in value) || !('error' in value) || typeof value.error !== 'string') {
    throw new Error('Expected a run refusal with a text error');
  }
  expect(value.ok).toBe(false);
  for (const fragment of typeof cause === 'string' ? [cause] : cause) expect(value.error).toContain(fragment);
  const { tool, ...args } = next;
  expect(value.error).toContain(`Next call: ${tool} ${JSON.stringify(args)}.`);
}

