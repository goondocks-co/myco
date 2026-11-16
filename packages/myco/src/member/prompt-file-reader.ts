import { constants, readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAgentScratchDirectory, temporaryFolders } from '@myco/utils/temporary-folders.js';
import { PROMPT_KEY_TEXT_MAX_CHARS as PROMPT_ASK_MAX_CHARS } from '@goondocks/myco-shared/prompt-identity';
import { PROMPT_FILE_CONTEXT_CHARS, PROMPT_FILE_OPENING_CHARS, type PromptFileInput, type PromptFileRead } from './prompt-file-policy.js';

const UTF8_BYTES_PER_CHAR = 4;
const BINARY_EXTENSION = /\.(?:pdf|svg|png|jpe?g|gif|webp|ico|avif|heic|bmp|tiff?|zip|gz|bz2|xz|7z|rar|tar|woff2?|ttf|otf|mp[34]|mov|wav|ogg|exe|dll|so|dylib|sqlite3?|db|wasm|bin)$/i;
const PRIVATE_COMPONENT = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.myco(?:-.*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;
const samePath = (left: string, right: string): boolean => path.relative(left, right) === '';
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Only named files within the project, temporary storage, or an explicit home work directory are admitted. */
interface FileRoot { root: string; home?: string }
function fileRoot(file: string, input: PromptFileInput, env: NodeJS.ProcessEnv): FileRoot | undefined {
  if (file.split(path.sep).some(part => PRIVATE_COMPONENT.test(part)) || BINARY_EXTENSION.test(file)) return undefined;
  if (inside(input.projectRoot, file)) return { root: input.projectRoot };
  const temporary = temporaryFolders(env).find(root => inside(path.resolve(root), file));
  if (temporary !== undefined) return { root: path.resolve(temporary) };
  const home = path.resolve(env.HOME ?? env.USERPROFILE ?? os.homedir());
  if (!inside(home, file)) return undefined;
  const parts = path.relative(home, file).split(path.sep);
  if (parts.length < 2) return undefined;
  if (parts[0]!.startsWith('.')) {
    const state = path.resolve(env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'));
    return inside(state, file) ? { root: state, home } : undefined;
  }
  return { root: path.join(home, parts[0]!), home };
}

/** One bounded opening read; physical aliases below the admitted root carry no permission. */
async function opening(file: string, policy: FileRoot, env: NodeJS.ProcessEnv, active: () => boolean): Promise<string | undefined> {
  const { root, home } = policy;
  const physicalRoot = await fs.realpath(root);
  if (home !== undefined && !samePath(physicalRoot, path.resolve(await fs.realpath(home), path.relative(home, root)))) return undefined;
  if (!active()) return undefined;
  const physical = await fs.realpath(file);
  if (!active() || !samePath(physical, path.resolve(physicalRoot, path.relative(root, file))) || isAgentScratchDirectory(file, env)) return undefined;
  const stat = await fs.lstat(physical);
  if (!active() || !stat.isFile()) return undefined;
  const handle = await fs.open(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!active() || !opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return undefined;
    if (!samePath(await fs.realpath(file), physical) || !active()) return undefined;
    const buffer = Buffer.alloc(PROMPT_FILE_OPENING_CHARS * UTF8_BYTES_PER_CHAR);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!active()) return undefined;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead), { stream: bytesRead < opened.size });
    if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text) || text.startsWith('%PDF-')) return undefined;
    return text.slice(0, PROMPT_FILE_OPENING_CHARS);
  } finally { await handle.close(); }
}

/** Each accepted opening is published before the next local read begins. */
export async function readPromptFiles(input: PromptFileRead, publish: (addition: string) => void): Promise<void> {
  const room = Math.min(PROMPT_FILE_CONTEXT_CHARS, PROMPT_ASK_MAX_CHARS - input.text.length);
  const env = input.env ?? process.env;
  const active = () => Date.now() < input.deadline;
  let appended = 0;
  const seen = new Set<string>();
  for (const named of input.references) {
    if (!active() || appended >= room) break;
    const file = path.resolve(input.cwd, named.startsWith('~/') ? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), named.slice(2)) : named);
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const root = fileRoot(file, input, env);
      if (root === undefined || !active()) continue;
      const excerpt = await opening(file, root, env, active);
      if (excerpt?.trim() && active()) {
        const addition = `\n\n[File opening]\n${excerpt}`.slice(0, room - appended);
        publish(addition);
        appended += addition.length;
      }
    } catch { /* Optional local context carries no capture or delivery obligation. */ }
  }
}

/** A private, read-only member operation: input and opening fragments travel only on its parent's pipes. */
export async function runPromptFileReader(): Promise<void> {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as PromptFileRead;
    await readPromptFiles(input, addition => process.stdout.write(addition));
  } catch { /* An unavailable opening contributes nothing to selection. */ }
}

if (import.meta.main) await runPromptFileReader();
