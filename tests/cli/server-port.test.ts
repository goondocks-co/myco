/**
 * `myco server create --port`, through the argv the operator actually types.
 *
 * The port is decided in one place for the flag and for the bundle's `.env`,
 * and a refusal has to name what was typed: a conversion in the CLI turned a
 * bare `--port` into the word "true" and a misspelled one into NaN, and the
 * operator read a value they had never written.
 */
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

describe('the port flag reaches its validator as it was typed', () => {
  it('refuses a port that is not a number, naming what was typed', async () => {
    const { code, said: message } = await refusal(['create', '--port', 'abc']);
    expect(code).toBe(1);
    expect(message).toContain('"abc"');
    expect(message).toContain('between 1 and 65535');
  });

  it('refuses a bare --port rather than reading the flag\'s own presence as a value', async () => {
    // `parseFlags` gives a valueless flag the string "true"; a conversion made
    // that NaN, and the operator read a value they never wrote.
    const { code, said: message } = await refusal(['create', '--port']);
    expect(code).toBe(1);
    expect(message).toContain('"true"');
    expect(message).not.toContain('NaN');
  });

  it('refuses --port= rather than publishing on an ephemeral pick', async () => {
    const { code, said: message } = await refusal(['create', '--port=']);
    expect(code).toBe(1);
    expect(message).not.toContain('"0"');
    expect(message).toContain('between 1 and 65535');
  });

  it('refuses a port outside the range, naming it', async () => {
    for (const typed of ['0', '-1', '70000', '8787.5']) {
      exitCode = null;
      said = [];
      const { code, said: message } = await refusal(['create', '--port', typed]);
      expect({ typed, code }).toEqual({ typed, code: 1 });
      expect({ typed, named: message.includes(`"${typed}"`) }).toEqual({ typed, named: true });
    }
  });
});
