import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promptFileReferences } from '@goondocks/myco-shared/prompt-file-references';
import { PROMPT_KEY_TEXT_MAX_CHARS as PROMPT_ASK_MAX_CHARS } from '@goondocks/myco-shared/prompt-identity';
import { isBundledPath, selfExec, type SelfExec } from '@myco/runtime/self-exec.js';
import { PROMPT_FILE_CONTEXT_CHARS, PROMPT_FILE_READ_BUDGET_MS, PROMPT_FILE_READER_VERB, type PromptFileInput } from './prompt-file-policy.js';

const UTF8_BYTES_PER_CHAR = 4;

/** The same reader under a checkout runtime or the compiled member's private command. */
function readerCommand(): SelfExec {
  if (!isBundledPath(fileURLToPath(import.meta.url))) return { path: process.execPath, args: ['--no-env-file', fileURLToPath(new URL('./prompt-file-reader.ts', import.meta.url))] };
  const self = selfExec();
  return { path: self.path, args: [...self.args, 'member', PROMPT_FILE_READER_VERB] };
}

/** Selection-only text; the reader's process is killed at the hook's deadline, including blocked filesystem work. */
export async function promptSelectionText(input: PromptFileInput, reader: SelfExec = readerCommand()): Promise<string> {
  const text = input.text.slice(0, PROMPT_ASK_MAX_CHARS);
  const references = promptFileReferences(text);
  const room = Math.min(PROMPT_FILE_CONTEXT_CHARS, PROMPT_ASK_MAX_CHARS - text.length);
  const wait = Math.min(PROMPT_FILE_READ_BUDGET_MS, input.deadline - Date.now());
  if (references.length === 0 || room <= 0 || wait <= 0) return text;
  const env = input.env ?? process.env;
  const readEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'XDG_STATE_HOME', 'MYCO_TEMPORARY_FOLDERS', 'TMPDIR'].flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
  try {
    const result = spawnSync(reader.path, reader.args, {
      cwd: input.cwd, windowsHide: true, encoding: 'utf8',
      input: JSON.stringify({ text, cwd: input.cwd, projectRoot: input.projectRoot, env: readEnv, references, deadline: Date.now() + wait }),
      timeout: wait, killSignal: 'SIGKILL', maxBuffer: PROMPT_FILE_CONTEXT_CHARS * UTF8_BYTES_PER_CHAR,
    });
    return text + (result.stdout ?? '').slice(0, room);
  } catch { return text; }
}
