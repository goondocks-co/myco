import { constants, readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROMPT_PROSE_EXTENSION } from '@goondocks/myco-shared/prompt-file-references';
import { promptFileRootRefusal } from '@goondocks/myco-shared/member-protocol';
import { isSafeProjectRoot } from '@myco/project-root.js';
import { isAgentScratchDirectory, temporaryFolders } from '@myco/utils/temporary-folders.js';
import { PROMPT_KEY_TEXT_MAX_CHARS as PROMPT_ASK_MAX_CHARS } from '@goondocks/myco-shared/prompt-identity';
import { PROMPT_FILE_CONTEXT_CHARS, PROMPT_FILE_OPENING_CHARS, type PromptFileInput, type PromptFileRead } from './prompt-file-policy.js';

const UTF8_BYTES_PER_CHAR = 4;
const BINARY_EXTENSION = /\.(?:pdf|svg|png|jpe?g|gif|webp|ico|avif|heic|bmp|tiff?|zip|gz|bz2|xz|7z|rar|tar|woff2?|ttf|otf|mp[34]|mov|wav|ogg|exe|dll|so|dylib|sqlite3?|db|wasm|bin)$/i;
const PRIVATE_COMPONENT = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.myco(?:-.*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;
const PRIVATE_NAME = /(?:secret|credential|creds|password|passwd|pgpass|token|key|id_(?:rsa|dsa|ecdsa|ed25519))/i;
/** A path part is private under its own name and under its name without a prose extension (`id_rsa.txt`, `.netrc.md`). */
const privatePart = (part: string): boolean => PRIVATE_COMPONENT.test(part) || PRIVATE_COMPONENT.test(part.replace(PROMPT_PROSE_EXTENSION, '')) || PRIVATE_NAME.test(part);
/** Text that holds a key block, a provider token or a credential assignment is never an opening, whatever the file is called. */
const SECRET_TEXT = new RegExp([
  '-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----',
  '\\bAKIA[0-9A-Z]{16}\\b', '\\baws_secret_access_key\\b',
  '\\bgh[pousr]_[A-Za-z0-9]{36,}', '\\bgithub_pat_[A-Za-z0-9_]{22,}',
  '\\bxox[abprs]-[A-Za-z0-9-]{10,}', '\\bsk-[A-Za-z0-9_-]{20,}', '\\bAIza[0-9A-Za-z_-]{35}\\b',
  '\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.',
  '\\b(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key)\\b["\']?\\s*[:=]\\s*["\']?[^\\s"\'<>{}$]{8,}',
].join('|'), 'i');
const samePath = (left: string, right: string): boolean => path.relative(left, right) === '';
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Home, an ancestor of home and a filesystem root are never a root of any kind. */
const broadRoot = (root: string, home: string): boolean => samePath(root, home) || inside(root, home) || samePath(root, path.parse(root).root);
/** The session's project: its credential's root, else the root the environment declares, else the working directory. */
const projectOf = (input: PromptFileInput, env: NodeJS.ProcessEnv): string => path.resolve(input.projectRoot ?? (env.MYCO_PROJECT_ROOT || input.cwd));
/** The working directory stands in for a project only on its own merits, never because the environment names some other root. */
const undeclared = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, MYCO_PROJECT_ROOT: undefined, MYCO_VAULT_DIR: undefined });

/** Only prose files within the project, temporary storage, or configured home work roots are admitted. */
interface FileRoot { root: string; home?: string }
function fileRoot(file: string, input: PromptFileInput, env: NodeJS.ProcessEnv): FileRoot | undefined {
  if (!PROMPT_PROSE_EXTENSION.test(file) || file.split(path.sep).some(privatePart) || BINARY_EXTENSION.test(file)) return undefined;
  const project = projectOf(input, env);
  if (inside(project, file)) return { root: project };
  const home = path.resolve(env.HOME ?? env.USERPROFILE ?? os.homedir());
  const temporary = temporaryFolders(env).map(root => path.resolve(root)).find(root => !broadRoot(root, home) && inside(root, file));
  if (temporary !== undefined) return { root: temporary };
  for (const named of input.roots ?? []) {
    if (promptFileRootRefusal(named) !== null) continue;
    const root = path.resolve(home, ...named.slice(2).split(/[\\/]/));
    if (inside(home, root) && inside(root, file)) return { root, home };
  }
  return undefined;
}

/** One bounded opening read; a root that is physically home or above it, and physical aliases below the admitted root, carry no permission. */
async function opening(file: string, policy: FileRoot, env: NodeJS.ProcessEnv, active: () => boolean): Promise<string | undefined> {
  const { root, home } = policy;
  const [physicalRoot, physicalHome] = await Promise.all([fs.realpath(root), fs.realpath(path.resolve(env.HOME ?? env.USERPROFILE ?? os.homedir()))]);
  if (broadRoot(physicalRoot, physicalHome)) return undefined;
  if (home !== undefined && !samePath(physicalRoot, path.resolve(physicalHome, path.relative(home, root)))) return undefined;
  if (!active()) return undefined;
  const physical = await fs.realpath(file);
  if (!active() || !samePath(physical, path.resolve(physicalRoot, path.relative(root, file))) || isAgentScratchDirectory(file, env)) return undefined;
  const stat = await fs.lstat(physical);
  if (!active() || !stat.isFile() || stat.nlink !== 1) return undefined;
  const handle = await fs.open(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!active() || !opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) return undefined;
    if (!samePath(await fs.realpath(file), physical) || !active()) return undefined;
    const buffer = Buffer.alloc(PROMPT_FILE_OPENING_CHARS * UTF8_BYTES_PER_CHAR);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!active()) return undefined;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead), { stream: bytesRead < opened.size });
    if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text) || text.startsWith('%PDF-') || SECRET_TEXT.test(text)) return undefined;
    return text.slice(0, PROMPT_FILE_OPENING_CHARS);
  } finally { await handle.close(); }
}

/** Each accepted opening is published before the next local read begins. */
export async function readPromptFiles(input: PromptFileRead, publish: (addition: string) => void): Promise<void> {
  if (input.references.length === 0) return;
  const room = Math.min(PROMPT_FILE_CONTEXT_CHARS, PROMPT_ASK_MAX_CHARS - input.text.length);
  const env = input.env ?? process.env;
  const home = path.resolve(env.HOME ?? env.USERPROFILE ?? os.homedir());
  const project = projectOf(input, env);
  if (broadRoot(project, home)) return;
  if (input.projectRoot === undefined && !env.MYCO_PROJECT_ROOT && !isSafeProjectRoot(input.cwd, undeclared(env))) return;
  try {
    const [physicalProject, physicalHome] = await Promise.all([fs.realpath(project), fs.realpath(home)]);
    if (broadRoot(physicalProject, physicalHome)) return;
  } catch { return; }
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
