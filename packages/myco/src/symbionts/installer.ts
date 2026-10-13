import { toolsStayOnDeployment } from '@goondocks/myco-shared/setup-guidance';
import { MYCO_MCP_SERVER_NAME, rawHasMycoOwnershipSignal } from '@myco/member/registration-ownership.js';
export { MYCO_MCP_SERVER_NAME, rawHasMycoOwnershipSignal } from '@myco/member/registration-ownership.js';
import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { expandHome, resolveMycoHome } from '@myco/paths/home.js';
import { isClaimedByPeer, readClaim, resolveClaimsHome, SYMBIONT_CONFIG_SUBSYSTEM } from '../member/subsystem-claim.js';
import { commandVerdict, mcpVerdict, MEMBER_PLUGIN_MARKER, MYCO_PLUGIN_FILE_MARKER, pluginFileVerdict } from './legacy-verdict.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readProvisionRecord, recordProvision } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';
import { assertSafeProjectRoot } from '../project-root.js';
import { findTomlSectionEnd, buildTomlMcpSection, upsertTomlSectionKeys, removeTomlSectionKeys, readTomlSectionKey } from './toml-helpers.js';
import { deepMergeSettingsWithAudit, emptyJsonAudit, removeAuditedSettings, type JsonSettingsAudit } from './settings-merge.js';
import { readJsonFile, writeJsonFile, writeOrDeleteJsonFile } from './json-helpers.js';
import { isMycoHookCommand, isMycoHookGroup, withoutMycoHooks, MYCO_MANAGED_MARKER } from './install-helpers.js';
import { hookCommands, memberHookTemplate } from './member-hooks.js';
import { CREDENTIAL_FLAG, SERVER_FLAG, type CredentialSource } from '../member/constants.js';
import { parseCredentialFlag } from '../member/credential.js';
import { admitMemberServerUrl, memberServerDialUrl } from '../member/server-url.js';
import { deploymentUrl } from '../member/registry.js';
import { MCP_PATH } from '../plugins/spec.js';
import { MCP_HEADERS_ARGS, MEMBER_MCP_LEVERS, memberMcpTemplate, memberRemoteMcp } from './member-hooks.js';
import { readRegistryEntry } from '../member/registry.js';

import { managedBinaryPath } from '../install/managed-binary.js';
import { resolveBinary } from '../runtime/binary-resolution.js';
import { BUNDLED_TEMPLATES } from './templates.generated.js';


function managedHookGroup(group: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(group.hooks)) return group;
  return { ...group, hooks: group.hooks.filter((hook: { command?: string }) => typeof hook.command === 'string' && isMycoHookCommand(hook.command)) };
}

const TEMPLATES_SUBDIR = 'src/symbionts/templates';


const REMOTE_MCP_TYPE = 'http';

export class MemberProvisionConflictError extends Error {}

export class MemberMcpConflictError extends MemberProvisionConflictError {
  constructor(message: string, readonly problem: string = message, cause?: unknown) {
    super(message, { cause });
  }
}

export class MemberPluginConflictError extends MemberProvisionConflictError {}

const TOML_MCP_SERVERS_KEY = 'mcp_servers';

function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

const KNOWN_MCP_SERVERS_KEYS = ['mcpServers', 'servers', 'mcp'] as const;

export { MYCO_PLUGIN_FILE_MARKER } from './legacy-verdict.js';

export { MEMBER_PLUGIN_MARKER } from './legacy-verdict.js';

const CREDENTIAL_SOURCE_PLACEHOLDER = '{{mycoCredentialSource}}';

const HOOKS_FORMAT_PLUGIN_FILE = 'plugin-file';

const PLUGIN_SHARED_HELPERS_START = '// <myco:shared-helpers>';
const PLUGIN_SHARED_HELPERS_END = '// </myco:shared-helpers>';

const PLUGIN_SHARED_HELPERS_SNIPPET = '_shared/plugin-helpers.ts.snippet';

const CURSOR_PROJECT_ROOT_PLACEHOLDER = '{{projectRootCd}}';
const CURSOR_PROJECT_ROOT_CD =
  'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo ${CURSOR_PROJECT_DIR:-.})"';

const MYCO_LAUNCHER_PLACEHOLDER = '{{mycoLauncher}}';

const MYCO_BINARY_PLACEHOLDER = '{{mycoBinary}}';

const CREDENTIAL_ARGV_WORDS = 2;

const HELPER_FLAG_WORDS = 4;

const MEMBER_BRIDGE_ARGS: readonly string[] = ['mcp'];

const MANAGED_BINARY_NAMES: readonly string[] = (['linux', 'win32'] as const)
  .map((platform) => managedBinaryPath('/', platform, '/').replaceAll('\\', '/').split('/').pop() ?? '');

function resolveLauncherCmd(binaryPath: string): string {
  assertSafeBinaryPathForUnquoted(binaryPath);
  return binaryPath;
}

export function resolveManagedBinaryPath(
  mycoHome: string = resolveMycoHome(),
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = resolveBinary('self-exec', { kind: 'machine' }, { mycoHome, platform });
  return resolved.path.replaceAll('\\', '/');
}

export const WHITESPACE_PATH_REFUSAL =
  'contains whitespace, which breaks direct-argv hook spawn for cursor / windsurf / pi. Move Myco out of a path with spaces.';

function assertSafeBinaryPathForUnquoted(binaryPath: string): void {
  if (!/\s/.test(binaryPath)) return;
  throw new Error(`Refusing to install symbiont hooks: binary path "${binaryPath}" ${WHITESPACE_PATH_REFUSAL}`);
}


function hookCommandsIn(raw: string): string[] {
  try {
    return hookCommands((JSON.parse(raw) as { hooks?: unknown }).hooks);
  } catch {
    return [...raw.matchAll(/"command"\s*:\s*("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]) as string);
  }
}

export interface InstallResult {
  hooks: boolean;
  mcp: boolean;
  skills: boolean;
  settings: boolean;
  instructions: boolean;
    pluginPackage: boolean;
    pluginManifest: boolean;
}

function emptyInstallResult(): InstallResult {
  return {
    hooks: false,
    mcp: false,
    skills: false,
    settings: false,
    instructions: false,
    pluginPackage: false,
    pluginManifest: false,
  };
}

export type InstallScope = 'member-global';

const JSON_ONLY_MCP_KEYS: readonly string[] = ['type', ...Object.keys(MEMBER_MCP_LEVERS)];

export function tomlMemberServers(block: Record<string, unknown>, projectRoot: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(block)) {
    if (!def || typeof def !== 'object') continue;
    const server = Object.fromEntries(Object.entries(def as Record<string, unknown>).filter(([key]) => !JSON_ONLY_MCP_KEYS.includes(key)));
    out[name] = 'url' in server ? server : { ...server, cwd: projectRoot };
  }
  return out;
}

export function throughLink(file: string): string {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return file;
  } catch {
    return file;
  }
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(path.dirname(file), fs.readlinkSync(file));
  }
}

function captureHolderNext(verdict: ReturnType<typeof commandVerdict> | null): string {
  if (verdict === 'legacy') return 'Review capture cutover with myco cutover --dry-run before handing capture over with myco cutover.';
  if (verdict === 'member') return 'Capture stays with the other 2.0 installation. Run myco doctor to check capture before changing global hooks.';
  return 'Run myco doctor to check which installation owns capture before changing global hooks.';
}

export class SymbiontInstaller {

  constructor(
  private manifest: SymbiontManifest,
  private projectRoot: string,
  private packageRoot: string,
    // When true, the bundled-templates fallback is suppressed. Tests use
    // this to exercise scenarios where a specific template file is absent
    // from the packageRoot without inheriting the baked-in copy.
  private suppressBundledTemplates: boolean = false,
    _vaultDir?: string,
    _groveId?: string | null,
    installScope: InstallScope = 'member-global',
    // The member home used for registry and provisioning reads.
  private memberHome?: string,
  ) {
    if (installScope !== 'member-global') throw new Error('Only member-global installation is supported');
  }

  private resolveAbsoluteTarget(field: 'hooks' | 'skills' | 'settings'): string | null{
 const reg = this.manifest.registration;
 if (!reg) return null;
 const target = field === 'hooks' ? reg.globalHooksTarget : field === 'skills' ? reg.globalSkillsTarget : reg.globalSettingsTarget;
 return target ? throughLink(expandHome(target)) : null;
}

  private resolveAbsoluteMcpTargets(): Array<{ path: string; serversKey: string }>{
 const reg = this.manifest.registration;
 return (reg?.globalMcpTarget ?? []).map(entry => ({
   path: expandHome(entry.path), serversKey: entry.serversKey ?? reg?.mcpServersKey ?? 'mcpServers',
 }));
}

  isConfigured(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (!targetPath) return false;
    let raw: string;
    try {
      raw = fs.readFileSync(targetPath, 'utf-8');
    } catch {
      return false;
    }
    // Plugin-file targets: prefer the bundle marker (opencode/pi
    // ship it inline). For plugin-file targets whose template is JSON
    // (antigravity's hooks.json), the marker comment isn't present;
    // fall through to the ownership-signal scan below.
    if (reg.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) {
      if (raw.includes(MYCO_PLUGIN_FILE_MARKER)) return true;
      return rawHasMycoOwnershipSignal(raw);
    }
    // JSON path: prefer the structured walk (catches a Myco-marked
    // group even if the command field gets renamed in a future
    // template). Fall back to substring detection when the file
    // isn't strict JSON — Codex's `~/.codex/hooks.json` ships with
    // a TOML `[features]` footer that JSON.parse rejects but the
    // agent itself reads happily. An inspector must answer "are we
    // wired in" correctly across both shapes; the writer (installHooks)
    // still owns the strict-JSON contract.
    try {
      const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown[]> };
      const hooks = parsed.hooks ?? {};
      for (const groups of Object.values(hooks)) {
        for (const group of groups as Array<Record<string, unknown>>) {
          if (isMycoHookGroup(group)) return true;
        }
      }
    } catch {
      /* fall through to substring scan */
    }
    return rawHasMycoOwnershipSignal(raw);
  }

  private readTemplateFile(relPath: string): string | null {
    // Prefer on-disk templates in dev/test so local edits and fixture package
    // roots are reflected immediately. The bundled map remains the compiled
    // binary fallback when those package files are unavailable under /$bunfs/.
    const candidates = [
      path.join(this.packageRoot, TEMPLATES_SUBDIR, relPath),
      // tsup preserves the src/ prefix under dist/, so the same subdir works in both layouts
      path.join(this.packageRoot, 'dist', TEMPLATES_SUBDIR, relPath),
    ];
    for (const filePath of candidates) {
      try { return fs.readFileSync(filePath, 'utf-8'); } catch { /* try next */ }
    }

    if (this.suppressBundledTemplates) return null;
    const key = relPath.split(path.sep).join('/');
    const bundled = BUNDLED_TEMPLATES[key];
    if (bundled !== undefined) return bundled;
    return null;
  }

  private writeManagedFile(absPath: string, content: string): boolean {
    try {
      if (fs.readFileSync(absPath, 'utf-8') === content) return false;
    } catch { /* doesn't exist — proceed */ }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    // Atomic write so a torn write to a shared user-home agent config
    // (under `installScope: 'global'`) can never leave the file
    // half-written.
    atomicWriteFileSync(absPath, content);
    return true;
  }

    loadMcpTemplate(): Record<string, unknown> | null {
    const template = this.loadTemplate('mcp');
    if (!template) return null;
    const binaryPath = this.binaryPath();
    const substitute = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value.split(MYCO_BINARY_PLACEHOLDER).join(binaryPath);
      }
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v)]),
        );
      }
      return value;
    };
    const resolved = substitute(template) as Record<string, unknown>;
    return resolved;
  }

    loadTemplate(name: string): Record<string, unknown> | null {
    const raw = this.readTemplateFile(path.join(this.manifest.name, `${name}.json`));
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

    loadTemplateRaw(filename: string): string | null {
    return this.readTemplateFile(path.join(this.manifest.name, filename));
  }

    install(): InstallResult{
      // Every refusal runs before the first write: a member is provisioned
      // with both surfaces or with neither, never with a plugin whose tools
      // the host would then refuse to serve.
      if (this.isMemberPluginFile()) {
        this.assertMemberMcpWritable();
        const hooks = this.writeMemberPlugin();
        return this.finishMemberInstall({ ...emptyInstallResult(), hooks, mcp: this.installMemberMcp() });
      }
      if (this.renderMemberHooks('registry') === null) return emptyInstallResult();
      this.assertMemberMcpWritable();
      const hooks = this.installMemberHooks();
      return this.finishMemberInstall({ ...emptyInstallResult(), hooks, mcp: this.installMemberMcp(), settings: this.installSettings() });
    }

  renderMemberHooks(source: CredentialSource): Record<string, unknown> | null {
    const reg = this.manifest.registration;
    if (!reg?.memberHooksTarget) return null;
    if (reg.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) return null;
    const rawTemplate = this.loadTemplate('hooks');
    if (!rawTemplate) return null;
    const block = this.resolveHookTemplatePlaceholders(memberHookTemplate(rawTemplate, source));
    for (const command of hookCommands(block)) {
      if (!command.includes(`${CREDENTIAL_FLAG} ${source}`)) {
        throw new Error(`Refusing to emit member hooks: a command declares no ${CREDENTIAL_FLAG} ${source} (${command})`);
      }
    }
    return block;
  }

  installMemberHooks(): boolean {
    this.assertMemberMcpWritable();
    const block = this.renderMemberHooks('registry');
    if (block === null) return false;
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (targetPath === null) return false;

    const settings = readJsonFile(targetPath);
    const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    const mergedHooks: Record<string, unknown[]> = {};
    for (const event of new Set([...Object.keys(existingHooks), ...Object.keys(block)])) {
      const wanted = [...((block[event] ?? []) as Record<string, unknown>[])];
      const merged: unknown[] = [];
      for (const group of (existingHooks[event] ?? []) as Record<string, unknown>[]) {
        if (!isMycoHookGroup(group)) { merged.push(group); continue; }
        const match = wanted.findIndex((candidate) => isDeepStrictEqual(candidate, managedHookGroup(group)));
        if (match >= 0) { wanted.splice(match, 1); merged.push(group); }
        else {
          const foreign = withoutMycoHooks([group]);
          if (foreign.length > 0) merged.push(...foreign);
          else if (wanted.length > 0) merged.push(wanted.shift());
        }
      }
      merged.push(...wanted);
      if (merged.length > 0) mergedHooks[event] = merged;
    }
    settings.hooks = mergedHooks;
    const reg = this.manifest.registration;
    if (reg?.hooksConfigVersion !== undefined) settings.version = reg.hooksConfigVersion;
    const written = writeJsonFile(targetPath, settings);
    return written;
  }

  renderMemberMcp(source: CredentialSource): Record<string, unknown> | null {
    const reg = this.manifest.registration;
    if (!reg?.mcpTarget) return null;
    if (reg.memberMcpHeadersHelperKey) {
      const serverUrl = readRegistryEntry(this.projectRoot, this.memberHomeDir())?.serverUrl ?? this.expectedServerUrl ?? this.deploymentUrl;
      if (serverUrl === undefined) return null;
      const binaryPath = this.binaryPath();
      assertSafeBinaryPathForUnquoted(binaryPath);
      // A JSON host reads `type` and the levers; a TOML host drops them (`tomlMemberServers`).
      const remote = memberRemoteMcp(serverUrl, reg.memberMcpHeadersHelperKey, binaryPath, source);
      return { [MYCO_MCP_SERVER_NAME]: { type: REMOTE_MCP_TYPE, ...remote, ...MEMBER_MCP_LEVERS } };
    }
    const template = this.loadMcpTemplate();
    return template === null ? null : memberMcpTemplate(template, source);
  }

  private memberHomeDir(): string {
    return this.memberHome ?? resolveMycoHome({ cwd: this.projectRoot });
  }

  private binaryPath(): string {
    return resolveManagedBinaryPath(this.memberHomeDir());
  }

  private memberMcpConflict(problem: string, remedy: string, cause?: unknown): MemberMcpConflictError {
    return new MemberMcpConflictError(
      `${problem}, so nothing was written. ${remedy}, then run \`myco member provision ${this.manifest.name}\`.`,
      problem,
      cause,
    );
  }

  private memberMcpTargetPath(): string | null {
    const target = this.resolveAbsoluteMcpTargets()[0]?.path ?? null;
    return target === null ? null : throughLink(target);
  }

  installMemberMcp(): boolean {
    this.assertMemberMcpWritable();
    const block = this.renderMemberMcp('registry');
    const targetPath = this.memberMcpTargetPath();
    if (block === null || targetPath === null) return false;
    const reg = this.manifest.registration!;
    // A TOML server list (Codex) is edited section by section; the JSON sweep
    // below is for the JSON targets. The JSON hosts' levers are not written.
    // Codex's remote entry needs no `cwd`: it runs the headers helper in the
    // session's directory, where the membership resolves the way every hook's does.
    if (reg.mcpFormat === 'toml') return this.installMcpToml(targetPath, tomlMemberServers(block, this.projectRoot));
    const serversKey = reg.mcpServersKey ?? 'mcpServers';
    const data = this.readMemberMcpTarget() ?? {};
    for (const candidateKey of KNOWN_MCP_SERVERS_KEYS) {
      if (candidateKey === serversKey) continue;
      const candidate = data[candidateKey];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const bag = candidate as Record<string, unknown>;
      if (!(MYCO_MCP_SERVER_NAME in bag)) continue;
      delete bag[MYCO_MCP_SERVER_NAME];
      if (Object.keys(bag).length === 0) delete data[candidateKey];
    }
    const servers = (data[serversKey] ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(block)) servers[name] = def;
    data[serversKey] = servers;
    return writeJsonFile(targetPath, data);
  }

  uninstallMemberMcp(): boolean {
    const targetPath = this.memberMcpTargetPath();
    if (targetPath === null || !fs.existsSync(targetPath)) return false;
    if (this.manifest.registration?.mcpFormat === 'toml') {
      return this.isMemberMcpServer(this.mycoServerIn(targetPath, true, TOML_MCP_SERVERS_KEY)) && this.uninstallMcpToml(targetPath);
    }
    const data = this.readMemberMcpTarget() ?? {};
    let removed = false;
    for (const key of KNOWN_MCP_SERVERS_KEYS) {
      const candidate = data[key];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const bag = candidate as Record<string, unknown>;
      if (!(MYCO_MCP_SERVER_NAME in bag)) continue;
      if (!this.isMemberMcpServer(bag[MYCO_MCP_SERVER_NAME])) continue;
      delete bag[MYCO_MCP_SERVER_NAME];
      removed = true;
      if (Object.keys(bag).length === 0) delete data[key];
    }
    if (!removed) return false;
    if (Object.keys(data).length === 0) {
      fs.rmSync(targetPath, { force: true });
      return true;
    }
    return writeJsonFile(targetPath, data);
  }

  private isMemberMcpServer(def: unknown): boolean {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return false;
    const server = def as Record<string, unknown>;
    const helperKey = this.manifest.registration?.memberMcpHeadersHelperKey;
    if (helperKey && typeof server[helperKey] === 'string' && server[helperKey].includes(CREDENTIAL_FLAG)) return true;
    return [server.command, server.args].some((list) => Array.isArray(list) && list.includes(CREDENTIAL_FLAG));
  }

  private readMcpFile(filePath: string, toml: boolean): Record<string, unknown> | null {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw this.memberMcpConflict(`could not read ${filePath} (${firstLine(error)})`, 'Fix the file', error);
    }
    try {
      const parsed: unknown = toml ? structuredClone(parseToml(raw)) : JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a configuration object');
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw this.memberMcpConflict(`could not read ${filePath} (${firstLine(error)})`, 'Fix the file');
    }
  }

  private mycoServerIn(filePath: string, toml: boolean, serversKey: string): Record<string, unknown> | null {
    const server = (this.readMcpFile(filePath, toml)?.[serversKey] as Record<string, unknown> | undefined)?.[MYCO_MCP_SERVER_NAME];
    return server && typeof server === 'object' && !Array.isArray(server) ? server as Record<string, unknown> : null;
  }

  private readMemberMcpTarget(): Record<string, unknown> | null {
    const targetPath = this.memberMcpTargetPath();
    if (targetPath === null) return null;
    return this.readMcpFile(targetPath, this.manifest.registration?.mcpFormat === 'toml');
  }

  private declaresUsableCredential(entry: Record<string, unknown>): boolean {
    if (this.helperWords(entry) !== null) return this.canonicalHelper(entry) !== null;
    const binary = this.launcherBinary(entry);
    if (binary === null || !this.namesMemberBinary(binary)) return false;
    const argv = this.launcherArgv(entry);
    if (argv === null || argv.length !== MEMBER_BRIDGE_ARGS.length + CREDENTIAL_ARGV_WORDS) return false;
    if (argv.slice(0, MEMBER_BRIDGE_ARGS.length).join(' ') !== MEMBER_BRIDGE_ARGS.join(' ')) return false;
    return parseCredentialFlag(argv.slice(-CREDENTIAL_ARGV_WORDS)) !== null;
  }

  private launcherArgv(entry: Record<string, unknown>): string[] | null {
    const argv: string[] = [];
    for (const [list, executable] of [[entry.command, 1], [entry.args, 0]] as const) {
      if (!Array.isArray(list)) continue;
      if (!list.every((word): word is string => typeof word === 'string')) return null;
      argv.push(...list.slice(executable));
    }
    return argv;
  }

  private canonicalHelper(entry: Record<string, unknown>): { source: CredentialSource; deployment: string } | null {
    const words = this.helperWords(entry);
    if (words === null || words[0] === undefined || !this.namesMemberBinary(words[0])) return null;
    if (words.slice(1, 1 + MCP_HEADERS_ARGS.length).join(' ') !== MCP_HEADERS_ARGS.join(' ')) return null;
    const flags = words.slice(1 + MCP_HEADERS_ARGS.length);
    if (flags.length !== HELPER_FLAG_WORDS || flags[0] !== CREDENTIAL_FLAG || flags[2] !== SERVER_FLAG) return null;
    const source = parseCredentialFlag(flags.slice(0, CREDENTIAL_ARGV_WORDS));
    const deployment = this.deploymentNamed(flags[3]);
    return source === null || deployment === null ? null : { source, deployment };
  }

  private launcherBinary(entry: Record<string, unknown>): string | null {
    const command = entry.command;
    if (typeof command === 'string') return command;
    return Array.isArray(command) && typeof command[0] === 'string' ? command[0] : null;
  }

  private namesMemberBinary(word: string): boolean {
    return word === this.binaryPath() || MANAGED_BINARY_NAMES.includes(word.replaceAll('\\', '/').split('/').pop() ?? word);
  }

  private helperWords(entry: Record<string, unknown>): string[] | null {
    const helperKey = this.manifest.registration?.memberMcpHeadersHelperKey;
    const helper = helperKey === undefined ? undefined : entry[helperKey];
    return typeof helper === 'string' ? helper.split(/\s+/).filter((word) => word !== '') : null;
  }

  private deploymentNamed(value: string | undefined): string | null {
    if (value === undefined) return null;
    const named = deploymentUrl(value);
    return admitMemberServerUrl(named) ? deploymentUrl(memberServerDialUrl(named)) : null;
  }

  private helperDeployment(entry: Record<string, unknown>): string | null {
    return this.canonicalHelper(entry)?.deployment ?? null;
  }

  private entryDeployment(entry: Record<string, unknown>): string | null {
    const url = entry.url;
    if (typeof url !== 'string' || !url.endsWith(MCP_PATH)) return null;
    return this.deploymentNamed(url.slice(0, -MCP_PATH.length));
  }

  inspectMemberHooks(): { scope: 'global' | 'project'; target: string | null; present: boolean; member: boolean; memberCommands: string[]; readable: boolean } {
    const scope = 'global' as const;
    const target = this.resolveAbsoluteTarget('hooks');
    const none = { scope, target, present: false, member: false, memberCommands: [] as string[] };
    if (target === null || !fs.existsSync(target)) return { ...none, readable: true };
    let raw: string;
    try {
      raw = fs.readFileSync(target, 'utf-8');
    } catch {
      return { ...none, readable: false };
    }
    const present = this.isConfigured();
    if (this.manifest.registration?.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) {
      return { ...none, present, member: present && raw.includes(MEMBER_PLUGIN_MARKER), readable: true };
    }
    const memberCommands = hookCommandsIn(raw)
      .filter((command) => isMycoHookCommand(command) && parseCredentialFlag(command.split(/\s+/)) !== null);
    return { ...none, present, member: present && memberCommands.length > 0, memberCommands, readable: true };
  }


  inspectMemberMcp(expectedDeployment?: string): Array<{ scope: 'global' | 'project'; present: boolean; transport: 'http' | 'stdio' | null; carriesCredential: boolean; declaredCwd: string | null; deploymentsAgree: boolean | null; namesExpectedDeployment: boolean | null; readable: boolean }> {
    const toml = this.manifest.registration?.mcpFormat === 'toml';
    const scope = 'global' as const;
    return this.resolveAbsoluteMcpTargets().map(({ path: filePath, serversKey }) => {
      // A TOML host keeps its servers under one section whatever the manifest names.
      const key = toml ? TOML_MCP_SERVERS_KEY : serversKey;
      let file: Record<string, unknown> | null;
      try {
        file = this.readMcpFile(filePath, toml);
      } catch {
        return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: false };
      }
      // A key that is not there is a file declaring no server; a key that is
      // there and is not a server block is a file nothing can read an entry
      // from, and each target answers for itself.
      const servers = file?.[key];
      if (file === null || servers === undefined) return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: true };
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
        return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: false };
      }
      const server = (servers as Record<string, unknown>)[MYCO_MCP_SERVER_NAME];
      if (server === undefined) return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: true };
      if (server === null || typeof server !== 'object' || Array.isArray(server)) {
        return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: false };
      }
      const entry = server as Record<string, unknown>;
      // A launcher names its command as a word or as an argument list; opencode writes the list.
      const launcher = typeof entry.command === 'string' || (Array.isArray(entry.command) && entry.command.length > 0);
      const transport = typeof entry.url === 'string' ? 'http' as const : launcher ? 'stdio' as const : null;
      // A launcher started outside the project finds its membership through the
      // directory the entry names, so the directory is a fact about it.
      const declaredCwd = typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : null;
      // What the entry declares is one fact; whether it is the entry member
      // provisioning writes — the one carrying this member's credential — is
      // another, and a server that is not cannot resolve the membership.
      // The Deployments the entry names, as answers rather than as URLs: whether
      // its own two agree, and whether they name the one the caller expects.
      // An entry naming neither answers nothing; one naming either must name
      // both, and name them the same, or it routes somewhere it cannot reach.
      const declares = typeof entry.url === 'string' || this.helperWords(entry) !== null;
      const dialled = this.entryDeployment(entry);
      const minted = this.helperDeployment(entry);
      const both = dialled !== null && minted !== null;
      const deploymentsAgree = !declares ? null : both && dialled === minted;
      const expected = expectedDeployment === undefined ? undefined : this.deploymentNamed(expectedDeployment);
      const namesExpectedDeployment = !declares || expected === undefined
        ? null
        : expected !== null && both && dialled === expected && minted === expected;
      return { scope, present: true, transport, carriesCredential: this.declaresUsableCredential(entry), declaredCwd,
        deploymentsAgree, namesExpectedDeployment, readable: true };
    });
  }

  private assertMemberMcpWritable(): void {
    this.preflightMemberSettings();
    this.readMemberMcpTarget();
    this.assertGlobalMemberOwnership();
  }

  private finishMemberInstall(result: InstallResult): InstallResult {
    const serverUrl = readRegistryEntry(this.projectRoot, this.memberHomeDir())?.serverUrl ?? this.deploymentUrl;
    if (serverUrl !== undefined) recordProvision(this.memberHomeDir(), { version: getPluginVersion(), serverUrl, agents: [this.manifest.name], binaries: { [this.manifest.name]: this.binaryPath() } });
    return result;
  }

  private legacyHomes: readonly string[] = [];
  private leavingDeployment: string | undefined;
  private expectedServerUrl: string | undefined;
  private deploymentUrl: string | undefined;
  private noProjectRoot = false;

  withoutProjectRoot(): this {
    this.noProjectRoot = true;
    return this;
  }

  forDeployment(serverUrl: string): this {
    this.deploymentUrl = serverUrl;
    return this;
  }

  replacingLegacy(homes: readonly string[]): this {
    this.legacyHomes = homes.map((home) => path.resolve(home));
    return this;
  }

  replacingDeployment(serverUrl: string): this {
    this.leavingDeployment = deploymentUrl(serverUrl);
    return this;
  }

  reconcileDeploymentLogout(leavingUrl: string, nextDefault: string | null, keepHooks: boolean): void {
    this.forDeployment(nextDefault ?? leavingUrl).replacingDeployment(leavingUrl);
    this.reconcileDeploymentMcp(leavingUrl, nextDefault, !keepHooks);
    if (!keepHooks) {
      this.assertGlobalMemberOwnership('hooks');
      this.uninstallMemberHooks();
    }
  }

  private reconcileDeploymentMcp(leavingUrl: string, nextDefault: string | null, removeUnscoped: boolean): void {
    const toml = this.manifest.registration?.mcpFormat === 'toml';
    for (const declared of this.resolveAbsoluteMcpTargets()) {
      const target = { ...declared, path: throughLink(declared.path) };
      const file = this.readMcpFile(target.path, toml);
      if (file === null) continue;
      const primaryKey = toml ? TOML_MCP_SERVERS_KEY : target.serversKey;
      const keys = toml ? [primaryKey] : [...new Set([primaryKey, ...KNOWN_MCP_SERVERS_KEYS])];
      let changed = false;
      let replacement: Record<string, unknown> | null = null;
      for (const key of keys) {
        const bag = file[key];
        if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
        const servers = bag as Record<string, unknown>;
        const entry = servers[MYCO_MCP_SERVER_NAME];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const server = entry as Record<string, unknown>;
        const dialled = this.entryDeployment(server);
        const minted = this.helperDeployment(server);
        const unscoped = dialled === null && minted === null && removeUnscoped && this.isMemberMcpServer(server);
        if (!unscoped && dialled !== deploymentUrl(leavingUrl) && minted !== deploymentUrl(leavingUrl)) continue;
        if (dialled !== minted) throw this.memberMcpConflict(`the Myco MCP entry in ${target.path} names conflicting Deployments`, 'Fix the entry');
        this.assertGlobalMemberOwnership({ path: target.path, serversKey: key });
        const desired = nextDefault === null ? null : this.renderMemberMcp('registry');
        replacement = desired;
        if (toml) {
          if (desired === null) this.uninstallMcpToml(target.path);
          else this.installMcpToml(target.path, tomlMemberServers(desired, this.projectRoot));
        } else {
          if (desired !== null && key === primaryKey) servers[MYCO_MCP_SERVER_NAME] = desired[MYCO_MCP_SERVER_NAME];
          else delete servers[MYCO_MCP_SERVER_NAME];
          if (Object.keys(servers).length === 0) delete file[key];
          changed = true;
        }
      }
      if (changed) {
        if (replacement !== null) {
          const primary = file[primaryKey];
          if (primary !== undefined && (!primary || typeof primary !== 'object' || Array.isArray(primary))) {
            throw this.memberMcpConflict(`the MCP server list in ${target.path} is malformed`, 'Fix the file');
          }
          const servers = (primary ?? {}) as Record<string, unknown>;
          if (!(MYCO_MCP_SERVER_NAME in servers)) {
            servers[MYCO_MCP_SERVER_NAME] = replacement[MYCO_MCP_SERVER_NAME];
            file[primaryKey] = servers;
          }
        }
        if (Object.keys(file).length === 0) fs.rmSync(target.path, { force: true });
        else writeJsonFile(target.path, file);
      }
    }
  }

  private claimHeldByLegacyHome(): boolean {
    const memberHome = this.memberHomeDir();
    const claim = readClaim(SYMBIONT_CONFIG_SUBSYSTEM, resolveClaimsHome());
    return claim !== null && this.legacyHomes.includes(path.resolve(claim.owner));
  }

  capturesAsMember(): boolean {
    return Boolean(this.manifest.registration?.memberHooksTarget);
  }

  memberGlobalTargets(): { hooks: string | null; mcp: string[]; all: string[] } {
    const hooks = this.resolveAbsoluteTarget('hooks');
    const written = this.memberMcpTargetPath();
    const mcp = written === null ? [] : [written];
    const all = [hooks, ...mcp, this.resolveAbsoluteTarget('settings')];
    return { hooks, mcp, all: [...new Set(all.filter((file): file is string => file !== null))] };
  }

  memberRegistrationPresent(): boolean {
    this.assertGlobalMemberOwnership();
    const target = this.resolveAbsoluteTarget('hooks');
    if (target !== null && fs.existsSync(target)) {
      if (this.isMemberPluginFile()) {
        if (fs.readFileSync(target, 'utf8').includes(MEMBER_PLUGIN_MARKER)) return true;
      } else if (hookCommands(this.readMcpFile(target, false)?.hooks).some((command) => rawHasMycoOwnershipSignal(command) && parseCredentialFlag(command.split(/\s+/)) === 'registry')) return true;
    }
    const mcp = this.memberMcpTargetPath();
    if (mcp === null) return false;
    const toml = this.manifest.registration?.mcpFormat === 'toml';
    const existing = this.mycoServerIn(mcp, toml, toml ? TOML_MCP_SERVERS_KEY : (this.manifest.registration?.mcpServersKey ?? 'mcpServers'));
    return existing !== null && this.isMemberMcpServer(existing);
  }

  memberRegistrationCurrent(): boolean {
    this.assertGlobalMemberOwnership();
    if (!this.memberSettingsCurrent()) return false;
    const target = this.resolveAbsoluteTarget('hooks');
    if (target === null || !fs.existsSync(target)) return false;
    if (this.isMemberPluginFile()) {
      if (fs.readFileSync(target, 'utf8') !== this.renderMemberPlugin('registry')) return false;
    } else {
      const hooks = this.readMcpFile(target, false)?.hooks;
      const managed = Object.fromEntries(Object.entries((hooks ?? {}) as Record<string, Record<string, unknown>[]>).flatMap(([event, groups]) => {
        const owned = groups.filter(isMycoHookGroup).map(managedHookGroup);
        return owned.length === 0 ? [] : [[event, owned]];
      }));
      const expectedHooks = this.renderMemberHooks('registry') ?? {};
      const sameGroups = (groups: unknown[], expected: unknown[]) => {
        const remaining = [...expected];
        return groups.length === expected.length && groups.every((group) => {
          const index = remaining.findIndex((candidate) => isDeepStrictEqual(group, candidate));
          if (index < 0) return false;
          remaining.splice(index, 1);
          return true;
        });
      };
      if (Object.keys(managed).length !== Object.keys(expectedHooks).length || Object.entries(expectedHooks).some(([event, groups]) => !sameGroups(managed[event] ?? [], groups as unknown[]))) return false;
    }
    const targetMcp = this.memberMcpTargetPath();
    const desired = this.renderMemberMcp('registry');
    if (targetMcp === null || desired === null) return true;
    const toml = this.manifest.registration?.mcpFormat === 'toml';
    const expected = (toml ? tomlMemberServers(desired, this.projectRoot) : desired)[MYCO_MCP_SERVER_NAME] as Record<string, unknown>;
    const existing = this.mycoServerIn(targetMcp, toml, toml ? TOML_MCP_SERVERS_KEY : (this.manifest.registration?.mcpServersKey ?? 'mcpServers'));
    return existing !== null && Object.entries(expected).every(([key, value]) => isDeepStrictEqual(existing[key], value));
  }

  private memberSettingsCurrent(): boolean {
    const target = this.resolveAbsoluteTarget('settings');
    const template = this.loadTemplate('settings');
    if (target === null || template === null) return true;
    const existing = this.readMcpFile(target, this.manifest.registration?.settingsFormat === 'toml') ?? {};
    return isDeepStrictEqual(existing, deepMergeSettingsWithAudit(existing, template, emptyJsonAudit()));
  }

  globalOwnership(serverUrl: string): { problem: string | null; replaces: string[] } {
    this.expectedServerUrl = serverUrl;
    try {
      this.assertGlobalMemberOwnership();
    } catch (error) {
      if (error instanceof MemberProvisionConflictError) return { problem: error.message, replaces: [] };
      throw error;
    } finally {
      this.expectedServerUrl = undefined;
    }
    const texts = [this.resolveAbsoluteTarget('hooks'), this.memberMcpTargetPath()]
      .flatMap((file) => { try { return file === null ? [] : [fs.readFileSync(file, 'utf8')]; } catch { return []; } });
    return { problem: null, replaces: this.legacyHomes.filter((home) => texts.some((text) => text.includes(`${home}${path.sep}`))) };
  }

  private assertGlobalMemberOwnership(targetOverride?: { path: string; serversKey: string } | 'hooks'): void {
    const memberHome = this.memberHomeDir();
    const record = readProvisionRecord(memberHome);
    const ownBinaries = [this.binaryPath(), managedBinaryPath(memberHome, process.platform), ...(record?.binaries?.[this.manifest.name] ? [record.binaries[this.manifest.name]] : [])];
    if (isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, memberHome, { claimsHome: resolveClaimsHome() }) && !this.claimHeldByLegacyHome()) {
      throw new MemberProvisionConflictError('Global symbiont configuration is claimed by another installation. Release its symbiont-config claim before provisioning globally.');
    }
    if (!this.noProjectRoot) {
      assertSafeProjectRoot(this.projectRoot);
    }
    const target = this.resolveAbsoluteTarget('hooks');
    if (target && fs.existsSync(target)) {
      if (this.isMemberPluginFile()) {
        let content: string;
        try { content = fs.readFileSync(target, 'utf8'); } catch (error) {
          throw new MemberProvisionConflictError(`could not read ${target} (${firstLine(error)}), so nothing was written.`);
        }
        const verdict = pluginFileVerdict(content, this.legacyHomes, memberHome);
        const replaceable = verdict === 'member' || (verdict === 'legacy' && this.legacyHomes.length > 0);
        if (!replaceable) {
          throw new MemberProvisionConflictError(`Global hooks at ${target} belong to another installation. ${captureHolderNext(content.includes(MEMBER_PLUGIN_MARKER) || content.includes(CREDENTIAL_FLAG) ? 'member' : verdict)}`);
        }
      } else {
        const settings = this.readMcpFile(target, false);
        const commands = hookCommands(settings?.hooks)
          .filter((command) => rawHasMycoOwnershipSignal(command) && !(this.legacyHomes.length > 0 && commandVerdict(command, this.legacyHomes) === 'legacy'));
        const foreign = commands.find((command) => parseCredentialFlag(command.split(/\s+/)) !== 'registry' || !ownBinaries.some((binary) => command.startsWith(`${binary} `)));
        if (foreign !== undefined) {
          throw new MemberProvisionConflictError(`Global hooks at ${target} belong to another installation (\`${foreign}\`). ${captureHolderNext(commandVerdict(foreign, this.legacyHomes))}`);
        }
      }
    }
    if (targetOverride === 'hooks') return;
    const reg = this.manifest.registration;
    const mcpTarget = targetOverride?.path ?? this.memberMcpTargetPath();
    if (!mcpTarget) return;
    const existing = this.mycoServerIn(mcpTarget, reg?.mcpFormat === 'toml', targetOverride?.serversKey ?? (reg?.mcpFormat === 'toml' ? TOML_MCP_SERVERS_KEY : (reg?.mcpServersKey ?? 'mcpServers')));
    if (existing === null) return;
    const desired = this.renderMemberMcp('registry')?.[MYCO_MCP_SERVER_NAME] as Record<string, unknown> | undefined;
    const helperKey = reg?.memberMcpHeadersHelperKey;
    const helper = helperKey && typeof existing[helperKey] === 'string' ? existing[helperKey] as string : null;
    const argv = Array.isArray(existing.command) ? existing.command : [existing.command, ...(Array.isArray(existing.args) ? existing.args : [])];
    const sameCredentialSource = helper !== null
      ? ownBinaries.some((binary) => helper.startsWith(`${binary} member mcp-headers `)) && parseCredentialFlag(helper.split(/\s+/)) === 'registry'
      : argv.every((arg): arg is string => typeof arg === 'string') && ownBinaries.includes(argv[0]) && parseCredentialFlag(argv) === 'registry';
    const legacy = this.legacyHomes.length > 0 && mcpVerdict(existing, this.legacyHomes) === 'legacy';
    const replacing = this.leavingDeployment !== undefined && this.entryDeployment(existing) === this.leavingDeployment
      && this.helperDeployment(existing) === this.leavingDeployment;
    if (!legacy && (!this.isMemberMcpServer(existing) || (existing.url !== desired?.url && !replacing) || !sameCredentialSource)) {
      const other = this.entryDeployment(existing);
      if (this.isMemberMcpServer(existing) && other !== null) {
        const message = toolsStayOnDeployment(this.manifest.displayName, other);
        throw new MemberMcpConflictError(message, message);
      }
      throw this.memberMcpConflict(`the global Myco MCP entry in ${mcpTarget} belongs to another installation or Deployment`, 'Review capture cutover with myco cutover --dry-run before handing capture over with myco cutover');
    }
  }

  isMemberPluginFile(): boolean {
    const reg = this.manifest.registration;
    return reg?.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE && Boolean(reg.memberHooksTarget);
  }

  private writeMemberPlugin(): boolean {
    const rendered = this.renderMemberPlugin('registry');
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (rendered === null || targetPath === null) return false;
    this.assertMemberPluginTargetIsMyco(targetPath);
    const written = this.writeManagedFile(targetPath, rendered);
    return written;
  }

  private assertMemberPluginTargetIsMyco(targetPath: string): void {
    let content: string;
    try {
      content = fs.readFileSync(targetPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new MemberPluginConflictError(
        `could not read ${targetPath} (${error instanceof Error ? error.message : String(error)}), so nothing was written.`,
      );
    }
    if (content.includes(MYCO_PLUGIN_FILE_MARKER) || rawHasMycoOwnershipSignal(content)) return;
    throw new MemberPluginConflictError(
      `${targetPath} is not a Myco plugin, so nothing was written and it was left as it is. Move it elsewhere if ${this.manifest.displayName} should load Myco's plugin here, then run \`myco member provision ${this.manifest.name}\`.`,
    );
  }

  assertMemberUninstallable(): void {
    this.assertGlobalMemberOwnership();
    this.preflightMemberSettings();
  }

  uninstallMemberRegistration(): void {
    this.assertMemberUninstallable();
    this.uninstallMemberHooks();
    this.uninstallMemberMcp();
    this.uninstallSettings();
  }

  uninstallMemberHooks(): boolean {
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (targetPath === null || !fs.existsSync(targetPath)) return false;
    if (this.isMemberPluginFile()) {
      // Only the member plugin: a 1.4 project plugin at the same path carries the generic marker alone.
      if (!fs.readFileSync(targetPath, 'utf-8').includes(MEMBER_PLUGIN_MARKER)) return false;
      fs.rmSync(targetPath, { force: true });
      return true;
    }
    const settings = readJsonFile(targetPath);
    const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    const kept: Record<string, unknown[]> = {};
    let removed = false;
    for (const [event, groups] of Object.entries(existingHooks)) {
      const foreign = withoutMycoHooks(groups as Array<Record<string, unknown>>, command => command.includes(CREDENTIAL_FLAG));
      if (!isDeepStrictEqual(groups, foreign)) removed = true;
      if (foreign.length > 0) kept[event] = foreign;
    }
    if (!removed) return false;
    if (Object.keys(kept).length > 0) {
      settings.hooks = kept;
    } else {
      delete settings.hooks;
    }
    if (Object.keys(settings).length === 0) {
      fs.rmSync(targetPath, { force: true });
      return true;
    }
    return writeJsonFile(targetPath, settings);
  }

  private substituteMycoLauncher(content: string): string {
    if (!content.includes(MYCO_LAUNCHER_PLACEHOLDER)) return content;
    const binaryPath = this.binaryPath();
    const launcherCmd = resolveLauncherCmd(binaryPath);
    const substituted = content.split(MYCO_LAUNCHER_PLACEHOLDER).join(launcherCmd);
    if (substituted.includes(MYCO_MANAGED_MARKER)) return substituted;
    return `${substituted} ${MYCO_MANAGED_MARKER}`;
  }

  private substituteCredentialSource(content: string, source: CredentialSource = 'registry'): string {
    return content.split(CREDENTIAL_SOURCE_PLACEHOLDER).join(source);
  }

  private refuseUnsubstituted(rendered: string, what: string): string {
    const left = /\{\{[A-Za-z0-9_.-]+\}\}/.exec(rendered);
    if (left !== null) {
      throw new Error(`Refusing to emit ${what} for symbiont ${this.manifest.name}: ${left[0]} was not substituted`);
    }
    return rendered;
  }

  private resolveHookTemplatePlaceholders(
    template: Record<string, unknown>,
  ): Record<string, unknown> {
    const substitute = (value: unknown): unknown => {
      if (typeof value === 'string') {
        let next = value;
        if (next.includes(CURSOR_PROJECT_ROOT_PLACEHOLDER)) {
          next = next.split(CURSOR_PROJECT_ROOT_PLACEHOLDER).join(CURSOR_PROJECT_ROOT_CD);
        }
        next = this.substituteMycoLauncher(next);
        return next;
      }
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v)]),
        );
      }
      return value;
    };

    return substitute(template) as Record<string, unknown>;
  }

      renderMemberPlugin(source: CredentialSource): string | null {
    const reg = this.manifest.registration;
    if (reg?.hooksFormat !== HOOKS_FORMAT_PLUGIN_FILE) return null;
    const templateFile = reg.hooksTemplateFile ?? 'plugin.ts';
    if (templateFile.endsWith('.json')) return null;
    const templateContent = this.loadTemplateRaw(templateFile);
    if (templateContent === null) return null;
    const rendered = this.substituteCredentialSource(
      this.substituteMycoLauncher(this.injectSharedPluginHelpers(templateContent)),
      source,
    );
    return this.refuseUnsubstituted(rendered, 'a plugin');
  }

  private injectSharedPluginHelpers(templateContent: string): string {
    const startIdx = templateContent.indexOf(PLUGIN_SHARED_HELPERS_START);
    if (startIdx === -1) return templateContent;
    const endIdx = templateContent.indexOf(PLUGIN_SHARED_HELPERS_END, startIdx);
    if (endIdx === -1) return templateContent;

    const snippet = this.readTemplateFile(PLUGIN_SHARED_HELPERS_SNIPPET);
    if (snippet === null) return templateContent;

    // Walk forward to the newline that ends the end-marker line so the
    // replacement slots in cleanly between whole lines.
    const endLine = templateContent.indexOf('\n', endIdx);
    const afterEnd = endLine === -1 ? templateContent.length : endLine;

    // Snippet is authored without surrounding markers — wrap it so the
    // installed file retains the same self-describing boundary contributors
    // use to navigate the source.
    const replacement =
      `${PLUGIN_SHARED_HELPERS_START}\n` +
      `${snippet.trimEnd()}\n` +
      `${PLUGIN_SHARED_HELPERS_END}`;

    return templateContent.slice(0, startIdx) + replacement + templateContent.slice(afterEnd);
  }

  private installMcpToml(targetPath: string, template: Record<string, unknown>): boolean {
    let original = '';
    try { original = fs.readFileSync(targetPath, 'utf-8'); } catch { /* doesn't exist */ }

    let raw = original;
    for (const [name, def] of Object.entries(template)) {
      raw = buildTomlMcpSection(raw, name, def as Record<string, unknown>);
    }

    // Idempotency (mirrors installMcpJson): skip the write when the upsert
    // produced no change, so the detection tick doesn't churn a config.toml the
    // agent owns on every pass.
    if (isDeepStrictEqual(parseToml(raw), parseToml(original))) return false;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFileSync(targetPath, raw);
    return true;
  }

    installSettings(): boolean {
    this.preflightMemberSettings();
    const reg = this.manifest.registration;
    if (!reg?.settingsTarget) return false;

    const template = this.loadTemplate('settings');
    if (!template) return false;

    const targetPath = this.resolveAbsoluteTarget("settings");
    // Plugin-file hook targets don't share their file with settings;
    // resolveAbsoluteTarget returns null in that case under global
    // scope so the settings template can't clobber the plugin source.
    if (!targetPath) return false;
    const settingsFormat = reg.settingsFormat ?? 'json';

    if (settingsFormat === 'toml') {
      return this.installSettingsToml(targetPath, template);
    }

    const existing = this.readMcpFile(targetPath, false) ?? {};
    // Audit-track every leaf Myco actually changes on disk so uninstall
    // can strip only what we wrote, never a user-pre-existing value
    // that happened to overlap with the template. Parity with the TOML
    // `installSettingsToml` audit.
    const audit = emptyJsonAudit();
    const merged = deepMergeSettingsWithAudit(existing, template, audit);
    const wrote = writeJsonFile(targetPath, merged);
    if (audit.scalars.length > 0 || audit.arrayEntries.length > 0) {
      // Merge with any pre-existing audit so re-installs accumulate
      // ownership claims (different template versions may legitimately
      // touch different paths over time). Paths are arrays; key on the
      // JSON-stringified form to avoid false-distinct paths.
      const existingAudit = this.readJsonSettingsAudit();
      if (existingAudit) {
        const seenScalarPaths = new Set(audit.scalars.map((s) => JSON.stringify(s.path)));
        for (const s of existingAudit.scalars) {
          if (!seenScalarPaths.has(JSON.stringify(s.path))) audit.scalars.push(s);
        }
        const arrayByPath = new Map(audit.arrayEntries.map((e) => [JSON.stringify(e.path), e]));
        for (const e of existingAudit.arrayEntries) {
          const key = JSON.stringify(e.path);
          const current = arrayByPath.get(key);
          if (current) {
            const seen = new Set(current.values.map((v) => JSON.stringify(v)));
            for (const v of e.values) {
              if (!seen.has(JSON.stringify(v))) current.values.push(v);
            }
          } else {
            audit.arrayEntries.push(e);
            arrayByPath.set(key, e);
          }
        }
      }
      this.writeJsonSettingsAudit(audit);
    }
    return wrote;
  }

  private getSettingsAuditPath(): string {
    const stateRoot = this.memberHomeDir();
    const scopeTag = 'global';
    return path.join(stateRoot, 'installer-audit', `${this.manifest.name}-${scopeTag}-settings.json`);
  }

  private preflightMemberSettings(): void {
    const target = this.resolveAbsoluteTarget('settings');
    if (target === null) return;
    this.readMcpFile(target, this.manifest.registration?.settingsFormat === 'toml');
    this.readMcpFile(this.getSettingsAuditPath(), false);
  }

  private readSettingsAudit(): string[] {
    const parsed = this.readMcpFile(this.getSettingsAuditPath(), false);
    return parsed?.schema === 1 && Array.isArray(parsed.wroteKeys)
      ? parsed.wroteKeys.filter((key): key is string => typeof key === 'string') : [];
  }

  private writeSettingsAudit(wroteKeys: string[]): void {
    const auditPath = this.getSettingsAuditPath();
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    writeJsonFile(auditPath, { schema: 1, wroteKeys });
  }

  private readJsonSettingsAudit(): JsonSettingsAudit | null {
    const parsed = this.readMcpFile(this.getSettingsAuditPath(), false) as Partial<JsonSettingsAudit> | null;
    if (parsed === null) return null;
    if (parsed.schema !== 2) return null;
    if (parsed.format !== 'json') return null;
    return {
      schema: 2,
      format: 'json',
      scalars: Array.isArray(parsed.scalars)
        ? parsed.scalars.filter((s): s is { path: string[]; value: unknown } =>
          !!s && Array.isArray(s.path) && s.path.every((seg) => typeof seg === 'string'))
        : [],
      arrayEntries: Array.isArray(parsed.arrayEntries)
        ? parsed.arrayEntries.filter((s): s is { path: string[]; values: unknown[] } =>
          !!s && Array.isArray(s.path) && s.path.every((seg) => typeof seg === 'string')
          && Array.isArray(s.values))
        : [],
    };
  }

  private writeJsonSettingsAudit(audit: JsonSettingsAudit): void {
    const auditPath = this.getSettingsAuditPath();
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    atomicWriteFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');
  }

  private deleteSettingsAudit(): void {
    try { fs.unlinkSync(this.getSettingsAuditPath()); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private installSettingsToml(targetPath: string, template: Record<string, unknown>): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const original = raw;

    const audit = new Set(this.readSettingsAudit());
    const templateKeys = new Set<string>();

    for (const [sectionName, values] of Object.entries(template)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const sectionValues = values as Record<string, unknown>;

      const mutate: Record<string, unknown> = {};
      for (const [key, templateVal] of Object.entries(sectionValues)) {
        const auditKey = `${sectionName}.${key}`;
        templateKeys.add(auditKey);
        const currentVal = readTomlSectionKey(raw, sectionName, key);
        const equal = currentVal !== undefined && String(currentVal) === String(templateVal);
        if (!equal) {
          mutate[key] = templateVal;
          audit.add(auditKey);
        }
        // If the value already matches but we previously recorded ownership,
        // keep the audit entry so uninstall still strips on Myco's behalf.
      }

      if (Object.keys(mutate).length > 0) {
        raw = upsertTomlSectionKeys(raw, sectionName, mutate);
      }
    }

    for (const entry of audit) if (!templateKeys.has(entry)) audit.delete(entry);

    const changed = !isDeepStrictEqual(parseToml(original), parseToml(raw));
    if (changed) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      atomicWriteFileSync(targetPath, raw);
    }
    this.writeSettingsAudit(Array.from(audit).sort());
    return changed;
  }

  uninstallSettings(): boolean {
    this.preflightMemberSettings();
    const reg = this.manifest.registration;
    if (!reg?.settingsTarget) return false;

    const template = this.loadTemplate('settings');
    if (!template) return false;

    const targetPath = this.resolveAbsoluteTarget("settings");
    if (!targetPath) return false;
    const settingsFormat = reg.settingsFormat ?? 'json';

    if (settingsFormat === 'toml') {
      return this.uninstallSettingsToml(targetPath, template);
    }

    const settings = this.readMcpFile(targetPath, false) ?? {};

    const audit = this.readJsonSettingsAudit();
    if (audit === null) return false;
    const declared = (segments: readonly string[]): boolean => segments.reduce<unknown>((value, key) =>
      value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, template) !== undefined;
    const changed = removeAuditedSettings(settings, { ...audit,
      scalars: audit.scalars.filter(entry => declared(entry.path)),
      arrayEntries: audit.arrayEntries.filter(entry => declared(entry.path)),
    });
    if (changed) writeOrDeleteJsonFile(targetPath, settings);
    this.deleteSettingsAudit();
    return changed;
  }

  private uninstallSettingsToml(targetPath: string, template: Record<string, unknown>): boolean {
    const audit = this.readSettingsAudit();
    if (audit.length === 0) {
      this.deleteSettingsAudit();
      return false;
    }

    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

    // Only currently declared settings remain managed.
    const templateSections = new Set<string>();
    for (const [sectionName, values] of Object.entries(template)) {
      if (values && typeof values === 'object' && !Array.isArray(values)) {
        templateSections.add(sectionName);
      }
    }

    const bySection = new Map<string, string[]>();
    for (const entry of audit) {
      const dot = entry.indexOf('.');
      if (dot < 0) continue;
      const section = entry.slice(0, dot);
      const key = entry.slice(dot + 1);
      if (!templateSections.has(section)) continue;
      const values = template[section] as Record<string, unknown>;
      if (!Object.hasOwn(values, key) || !isDeepStrictEqual(readTomlSectionKey(raw, section, key), values[key])) continue;
      const bucket = bySection.get(section) ?? [];
      bucket.push(key);
      bySection.set(section, bucket);
    }

    let changed = false;
    for (const [sectionName, keys] of bySection) {
      const next = removeTomlSectionKeys(raw, sectionName, keys);
      if (next !== raw) {
        raw = next;
        changed = true;
      }
    }

    if (changed) {
      if (!raw.trim()) {
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
      } else {
        atomicWriteFileSync(targetPath, raw);
      }
    }

    this.deleteSettingsAudit();
    return changed;
  }

  private uninstallMcpToml(targetPath: string): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { return false; }

    const sectionHeader = `[mcp_servers.${MYCO_MCP_SERVER_NAME}]`;
    if (!raw.includes(sectionHeader)) return false;

    const startIdx = raw.indexOf(sectionHeader);
    const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, `mcp_servers.${MYCO_MCP_SERVER_NAME}`);
    const before = raw.slice(0, startIdx).trimEnd();
    const after = raw.slice(endIdx).trimStart();
    const updated = (before + (before && after ? '\n\n' : '') + after).trimEnd();

    if (!updated.trim()) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    } else {
      atomicWriteFileSync(targetPath, updated + "\n");
    }
    return true;
  }
}
