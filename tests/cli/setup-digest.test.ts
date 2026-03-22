import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { run } from '@myco/cli/setup-digest';

describe('myco setup-digest', () => {
  let originalLog: typeof console.log;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(' '));
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('prints deprecation message', async () => {
    await run([], '/tmp/unused');
    expect(logged.some((l) => l.includes('removed in v3'))).toBe(true);
  });

  it('suggests using setup-llm for embedding config', async () => {
    await run(['--show'], '/tmp/unused');
    expect(logged.some((l) => l.includes('setup-llm') || l.includes('config set'))).toBe(true);
  });
});
