/**
 * PreToolUse: the member registers no PreToolUse hook (recall arrives with
 * the recall endpoint); when a harness still invokes it, the hook reads its
 * input and answers the empty response so the tool call is never blocked.
 */
import { readHookInput } from './input.js';
import { writeHookResponse } from './response.js';
import type { HookMainOptions } from '../member/capture.js';

export async function main(_opts: HookMainOptions = {}): Promise<void> {
  let symbiont: string | undefined;
  try {
    const input = await readHookInput();
    symbiont = input.agent;
  } catch (error) {
    process.stderr.write(`[myco] pre-tool-use error: ${(error as Error).message}\n`);
  } finally {
    writeHookResponse(symbiont, 'pre-tool-use', {});
  }
}
