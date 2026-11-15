import { readHookInput } from '../hooks/input.js';
import { writeHookResponse, type HookResponse } from '../hooks/response.js';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { parseCredentialFlag, resolveCredential } from './credential.js';
import { hookCwd, type HookMainOptions } from './capture.js';
import { resolveMycoHome } from '../paths/home.js';
import { isAgentScratchDirectory } from '../utils/temporary-folders.js';
import { terminalText } from '../utils/terminal-text.js';
import { MemberSpool } from './spool.js';
import { kickHelper } from './helper.js';
import { toolPromptContext } from './prompt-context.js';

/** Render a ready recall locally; an absent answer creates nothing and starts no helper. */
export async function renderToolRecall(opts: HookMainOptions): Promise<void> {
  try {
    const input = await readHookInput();
    if (!input.sessionId || HOOK_CONFIG[input.agent]?.capabilities.promptRecallToolDelivery !== true) return;
    const source = opts.credential === undefined ? parseCredentialFlag(opts.argv ?? process.argv) : opts.credential;
    if (source !== 'registry') return;
    const cwd = hookCwd(input);
    const env = opts.env ?? process.env;
    if (isAgentScratchDirectory(cwd, env)) return;
    const mycoHome = resolveMycoHome({ cwd });
    const credential = resolveCredential(source, { cwd, env, mycoHome, readOnly: true });
    if (credential === null) return;
    const spool = new MemberSpool(credential, { mycoHome, initialize: false });
    const snapshot = spool.peekSessionState(input.sessionId);
    if (!snapshot.ok && snapshot.reason === 'missing') return;
    if (!snapshot.ok) throw new Error(`Prompt recall state is ${snapshot.reason}`);
    const recall = snapshot.state.promptRecall;
    const held = recall?.asks[recall.current];
    if (held?.stage !== 'ready' || !held.late) return;
    const sessionId = input.sessionId;
    const now = opts.now ?? Date.now;
    const run = { input, sessionId, agent: input.agent, credential, spool, ctx: { agent: input.agent, sessionId, stage: spool.stagerFor(sessionId), now } };
    let response: HookResponse | undefined;
    let delivered = false;
    spool.appendAndRecord(sessionId, state => {
      const claimed = toolPromptContext(run, state);
      response = claimed.response;
      delivered = claimed.events.length > 0;
      return claimed.events;
    }, undefined, now());
    if (response?.additionalContext !== undefined) writeHookResponse(input.agent, input.raw.hook_event_name === 'PostToolUseFailure' ? 'post-tool-use-failure' : 'post-tool-use', response);
    if (delivered) kickHelper({ projectId: credential.projectId, serverUrl: credential.serverUrl, mycoHome, spawn: opts.helperSpawn, now });
  } catch (error) {
    process.stderr.write(`[myco] prompt recall hook failed: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  }
}
