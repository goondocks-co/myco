/** Port validation for a native Deployment through the operator's CLI arguments. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { run } from '@myco/cli/server';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';

let sandbox: ReturnType<typeof sandboxMycoHome>;
let exitCode: number | null = null;
let said: string[] = [];
const realExit = process.exit;
const realError = console.error;

beforeEach(() => {
  sandbox = sandboxMycoHome('myco-server-port-');
  exitCode = null;
  said = [];
  console.error = (...parts: unknown[]) => { said.push(parts.map(String).join(' ')); };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  process.exit = realExit;
  console.error = realError;
  sandbox.restore();
});

/** Runs the verb and answers what it printed on the way out. */
async function refusal(args: string[]): Promise<{ code: number | null; said: string }> {
  try {
    await run(args);
  } catch (err) {
    if (!/process\.exit/.test((err as Error).message)) throw err;
  }
  return { code: exitCode, said: said.join('\n') };
}

describe('the native Deployment port flag', () => {
  it('refuses a port that is not a number', async () => {
    const { code, said: message } = await refusal(['create', '--target', 'local', '--port', 'abc']);
    expect(code).toBe(1);
    expect(message).toContain('--port needs a whole number');
  });

  it('refuses a bare --port', async () => {
    const { code, said: message } = await refusal(['create', '--target', 'local', '--port']);
    expect(code).toBe(1);
    expect(message).toContain('--port needs a whole number');
    expect(message).not.toContain('NaN');
  });

  it('refuses --port= rather than publishing on an ephemeral pick', async () => {
    const { code, said: message } = await refusal(['create', '--target', 'local', '--port=']);
    expect(code).toBe(1);
    expect(message).toContain('port must be a whole number from 1 to 65535');
  });

  it('refuses a port outside the range', async () => {
    for (const typed of ['0', '-1', '70000', '8787.5']) {
      exitCode = null;
      said = [];
      const { code, said: message } = await refusal(['create', '--target', 'local', '--port', typed]);
      expect({ typed, code }).toEqual({ typed, code: 1 });
      expect(message).toMatch(/(?:--port needs a whole number|port must be a whole number from 1 to 65535)/);
    }
  });
});
