import { findingOwnedBinary, ownedHookBinary, ownedMcpBinary, ownedPluginBinary, mayTakeOverBinary } from '@myco/symbionts/registration-takeover.js';
import { toolsStayOnDeploymentGuidance } from '@goondocks/myco-shared/setup-guidance';
import { joinSentences } from '@myco/utils/sentences.js';
import { MYCO_MCP_SERVER_NAME, rawHasMycoOwnershipSignal } from '@myco/member/registration-ownership.js';
export { MYCO_MCP_SERVER_NAME, rawHasMycoOwnershipSignal } from '@myco/member/registration-ownership.js';
import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, TomlError } from 'smol-toml';
import { expandHome, resolveMycoHome } from '@myco/paths/home.js';
import { isClaimedByPeer, readClaim, resolveClaimsHome, SYMBIONT_CONFIG_SUBSYSTEM } from '../member/subsystem-claim.js';
import { commandVerdict, mcpVerdict, MEMBER_PLUGIN_MARKER, MYCO_PLUGIN_FILE_MARKER, pluginFileVerdict } from './legacy-verdict.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readProvisionRecord, readProvisionRecordStrict, recordProvision } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';
import { assertSafeProjectRoot } from '../project-root.js';
import { findTomlSectionEnd, buildTomlMcpSection, upsertTomlSectionKeys, removeTomlSectionKeys, readTomlSectionKey, readTomlSectionKeyLine } from './toml-helpers.js';
import { deepMergeSettingsWithAudit, emptyJsonAudit, removeAuditedSettings, type JsonSettingsAudit, type SettingsFileAudit } from './settings-merge.js';
import { retiredHookSettings, RetiredHookSettingsParseError, type RetiredSettingsConflict } from './retired-hook-settings.js';
import { readJsonFile, writeJsonFile, writeOrDeleteJsonFile } from './json-helpers.js';
import { isMycoHookCommand, isMycoHookGroup, withoutMycoHooks, MYCO_MANAGED_MARKER } from './install-helpers.js';
import { hookCommands, memberHookTemplate } from './member-hooks.js';
import { CREDENTIAL_FLAG, SERVER_FLAG, type CredentialSource } from '../member/constants.js';
import { parseCredentialFlag } from '../member/credential.js';
import { admitMemberServerUrl, memberServerDialUrl } from '../member/server-url.js';
import { deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult, readRegistryEntryResult, readDeploymentMembershipResult } from '../member/registry.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { MCP_ROOT_FLAG, MCP_CLIENT_ROOTS_FLAG, mcpProjectFolder } from '@myco/cli/flags.js';
import { privateMcpProjects, reconcilePrivateMcpProjects } from './member-mcp-projects.js';
import { MCP_PATH } from '../plugins/spec.js';
import { MCP_HEADERS_ARGS, MEMBER_MCP_LEVERS, memberMcpTemplate, memberRemoteMcp } from './member-hooks.js';
import { readRegistryEntry } from '../member/registry.js';
import { scanLegacyRegistrations, staleRegistrationWords, type LegacyFinding } from '@myco/member/legacy-registration-files.js';

import { managedBinaryPath } from '../install/managed-binary.js';
import { resolveBinary } from '../runtime/binary-resolution.js';
import { BUNDLED_TEMPLATES } from './templates.generated.js';

function managedHookGroup(group: Record<string, unknown>, matches = isMycoHookCommand): Record<string, unknown> {
  if (!Array.isArray(group.hooks)) return group;
  return { ...group, hooks: group.hooks.filter((hook: { command?: string }) => typeof hook.command === 'string' && matches(hook.command)) };
}

const TEMPLATES_SUBDIR = 'src/symbionts/templates';

const REMOTE_MCP_TYPE = 'http';

export class MemberProvisionConflictError extends Error {
  constructor(readonly problem: string, readonly remedy: string, options?: ErrorOptions) {
    super(joinSentences(problem, remedy), options);
  }
}

export class MemberRetiredSettingsRefusal extends MemberProvisionConflictError {
  constructor(readonly file: string, cause: unknown) {
    super(`Could not reconcile retired settings in ${file} (${firstLine(cause)}), so nothing was written there.`, 'Review this file before changing its settings.', { cause });
  }
}

interface RetiredSettingsReport {
  values: Record<string, string[]>;
  problem?: string;
}

interface MemberToolsRecovery { address: string; file: string; entry: string }

function toolsRecoveryRemedy({ address, file, entry }: MemberToolsRecovery): string {
  return `Run \`myco login ${address}\`, or remove \`${entry}\` in \`${file}\` and run \`myco member provision --refresh\`.`;
}

export class MemberMcpConflictError extends MemberProvisionConflictError {
  readonly toolsDeployment?: string;
  readonly repairAction?: string;
  private readonly toolsRecovery?: MemberToolsRecovery;

  constructor(problem: string, remedy: string, options: ErrorOptions & { toolsDeployment?: string; repairAction?: string; toolsRecovery?: MemberToolsRecovery } = {}) {
    super(problem, remedy, options);
    this.toolsDeployment = options.toolsDeployment;
    this.repairAction = options.repairAction;
    this.toolsRecovery = options.toolsRecovery;
  }

  get localRemedy(): string | undefined {
    return this.toolsRecovery === undefined ? undefined : toolsRecoveryRemedy(this.toolsRecovery);
  }
}

export class MemberPluginConflictError extends MemberProvisionConflictError { }

export class MemberPendingLogoutError extends MemberMcpConflictError {
  constructor(agent: string, leaving: string) {
    const problem = `${agent} is waiting for \`myco logout ${leaving}\` to finish.`;
    super(problem, `Run \`myco logout ${leaving}\` again; it names any file it still can't read.`, { repairAction: problem });
  }

  override get localRemedy(): string { return this.remedy; }
}

export class MemberFileReadRefusal extends MemberMcpConflictError {
  constructor(readonly file: string, cause: unknown, agent?: string) {
    const remedy = agent === undefined ? 'Restore read access and valid configuration before retrying.' : `Fix the file, then run \`myco member provision ${agent}\`.`;
    super(`could not read ${file} (${firstLine(cause)}), so nothing was written there.`, remedy, { cause, repairAction: remedy });
  }

  override get localRemedy(): string { return this.remedy; }
}

/** Isolate named file refusals while allowing unexpected failures to propagate. */
export function isolateMemberFileRefusal<T>(operation: () => T, report: (error: MemberFileReadRefusal | MemberRetiredSettingsRefusal) => void): T | null {
  try { return operation(); }
  catch (error) {
    if (!(error instanceof MemberFileReadRefusal) && !(error instanceof MemberRetiredSettingsRefusal)) throw error;
    report(error);
    return null;
  }
}

/** Collect each agent's outcome and defer unexpected failures until reconciliation ends. */
export class MemberFileReconciliation {
  readonly problems = new Map<string, string>();
  private readonly refusals = new Map<string, string>();
  private readonly unexpected: unknown[] = [];

  attempt<T>(manifest: SymbiontManifest, operation: () => T): T | null {
    try {
      return isolateMemberFileRefusal(operation, error => {
        const problem = `${manifest.displayName}: ${error.problem}`;
        this.problems.set(manifest.name, problem);
        this.refusals.set(manifest.name, problem);
      });
    } catch (error) {
      this.problems.set(manifest.name, `${manifest.displayName}: ${firstLine(error)}`);
      this.unexpected.push(error);
      return null;
    }
  }

  finish(operation: () => void, report: (problem: string) => void): void {
    try {
      operation();
      this.throwUnexpected();
    } catch (error) {
      for (const problem of this.refusals.values()) report(problem);
      throw error;
    }
  }

  throwUnexpected(): void {
    if (this.unexpected.length > 0) throw this.unexpected[0];
  }
}

export class MemberStaleRegistrationError extends MemberProvisionConflictError {
  constructor(messages: string[]) {
    super(messages.join('\n'), '');
  }
}

const TOML_MCP_SERVERS_KEY = 'mcp_servers';

function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && !error.code.startsWith('ERR_');
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
const ROOT_ARGV_WORDS = 2;
const MCP_OWNERSHIP_REMEDY = 'Review capture cutover with myco cutover --dry-run before handing capture over with myco cutover';

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

export type MemberRegistrationScan = ReadonlyArray<LegacyFinding & { target: string; replacementBinary?: string }>;

export interface InstallResult {
  hooks: boolean;
  mcp: boolean;
  skills: boolean;
  settings: boolean;
  instructions: boolean;
  pluginPackage: boolean;
  pluginManifest: boolean;
}

export interface MemberMcpInspection {
  scope: 'global' | 'project' | 'local';
  present: boolean;
  transport: 'http' | 'stdio' | null;
  carriesCredential: boolean;
  declaredCwd: string | null;
  deploymentsAgree: boolean | null;
  namesExpectedDeployment: boolean | null;
  readable: boolean;
  trusted?: boolean;
  sessionCwd?: boolean;
  shadowed?: boolean;
  configuredDeployment?: string;
  configPath?: string;
  context?: 'explicit-folder' | 'session-cwd' | 'fixed-deployment' | 'launch-cwd' | 'client-roots';
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

const JSON_ONLY_MCP_KEYS: readonly string[] = ['type', ...Object.keys(MEMBER_MCP_LEVERS)];

export function tomlMemberServers(block: Record<string, unknown>, projectRoot?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(block)) {
    if (!def || typeof def !== 'object') continue;
    const server = Object.fromEntries(Object.entries(def as Record<string, unknown>).filter(([key]) => !JSON_ONLY_MCP_KEYS.includes(key)));
    out[name] = 'url' in server || projectRoot === undefined ? server : { ...server, cwd: projectRoot };
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
    // The member home used for registry and provisioning reads.
    private memberHome?: string,
  ) {
  }

  private resolveAbsoluteTarget(field: 'hooks' | 'skills' | 'settings'): string | null {
    const reg = this.manifest.registration;
    if (!reg) return null;
    const target = field === 'hooks' ? reg.globalHooksTarget : field === 'skills' ? reg.globalSkillsTarget : reg.globalSettingsTarget;
    return target ? throughLink(expandHome(target)) : null;
  }

  private resolveAbsoluteMcpTargets(): Array<{ path: string; serversKey: string }> {
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

  install(scan = this.scanMemberRegistrations()): InstallResult {
    this.assertMemberProvisionAllowed();
    // Ownership and settings are admitted before the first write.
    if (this.isMemberPluginFile()) {
      this.assertMemberMcpWritable(scan);
      const hooks = this.writeMemberPlugin(scan);
      return this.finishMemberInstall({ ...emptyInstallResult(), hooks, mcp: this.installMemberMcp(scan) });
    }
    if (this.renderMemberHooks('registry') === null) return { ...emptyInstallResult(), settings: this.migrateRetiredHookSettings(scan) };
    this.assertMemberMcpWritable(scan);
    const migrated = this.migrateRetiredHookSettings(scan);
    const settings = this.installSettings(scan) || migrated;
    const hooks = this.installMemberHooks(scan);
    return this.finishMemberInstall({ ...emptyInstallResult(), hooks, mcp: this.installMemberMcp(scan), settings });
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

  installMemberHooks(scan = this.scanMemberRegistrations()): boolean {
    this.assertMemberMcpWritable(scan);
    const block = this.renderMemberHooks('registry');
    if (block === null) return false;
    return this.writeRegistrationTarget(this.resolveAbsoluteTarget('hooks'), 'hooks', scan, (targetPath) => {

      const settings = readJsonFile(targetPath);
      const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
      const mergedHooks: Record<string, unknown[]> = {};
      for (const event of new Set([...Object.keys(existingHooks), ...Object.keys(block)])) {
        const wanted = [...((block[event] ?? []) as Record<string, unknown>[])];
        const merged: unknown[] = [];
        for (const group of (existingHooks[event] ?? []) as Record<string, unknown>[]) {
          if (!hookCommands(group).some(command => this.managesHook(command))) { merged.push(group); continue; }
          const match = wanted.findIndex((candidate) => isDeepStrictEqual(candidate, managedHookGroup(group, command => this.managesHook(command))));
          if (match >= 0) { wanted.splice(match, 1); merged.push(group); }
          else {
            const foreign = withoutMycoHooks([group], command => this.managesHook(command));
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
    });
  }

  renderMemberMcp(source: CredentialSource, serverUrlOverride?: string): Record<string, unknown> | null {
    const reg = this.manifest.registration;
    if (!reg?.mcpTarget) return null;
    if (reg.memberMcpHeadersHelperKey && !this.sessionMcpRouting()) {
      const serverUrl = serverUrlOverride ?? readRegistryEntry(this.projectRoot, this.memberHomeDir())?.serverUrl ?? this.expectedServerUrl ?? this.deploymentUrl;
      if (serverUrl === undefined) return null;
      const binaryPath = this.binaryPath();
      assertSafeBinaryPathForUnquoted(binaryPath);
      // A JSON host reads `type` and the levers; a TOML host drops them (`tomlMemberServers`).
      const remote = memberRemoteMcp(serverUrl, reg.memberMcpHeadersHelperKey, binaryPath, source);
      return { [MYCO_MCP_SERVER_NAME]: { type: REMOTE_MCP_TYPE, ...remote, ...MEMBER_MCP_LEVERS } };
    }
    const template = this.loadMcpTemplate();
    return template === null ? null : memberMcpTemplate(template, source, reg.memberMcpRouting === 'client-roots');
  }

  private multipleMcpDeployments(): boolean {
    if (this.manifest.registration?.memberMcpRouting === undefined) return false;
    const read = listDeploymentMembershipsResult(this.memberHomeDir());
    if (!read.readable || read.unavailableEntries > 0) throw this.memberMcpConflict("this machine's Myco connections could not all be read", 'Restore access to its connection files');
    if (new Set(read.memberships.map(member => deploymentUrl(member.serverUrl))).size <= 1) return false;
    const projects = listRegistryEntriesResult(this.memberHomeDir());
    if (!projects.readable || projects.unavailableEntries > 0 || projects.conflicts?.length) throw this.memberMcpConflict('the project connections could not all be read', 'Restore access to the project connection files');
    return projects.entries.length > 0;
  }

  private sessionMcpRouting(): boolean {
    return this.manifest.registration?.memberMcpRouting === 'session-cwd' && this.multipleMcpDeployments();
  }

  private ownRoutedMcp(entry: unknown): boolean {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const server = entry as Record<string, unknown>;
    if (server.env !== undefined || server.environment !== undefined) return false;
    const recorded = readProvisionRecord(this.memberHomeDir())?.binaries?.[this.manifest.name];
    const binary = this.helperWords(server)?.[0] ?? this.launcherBinary(server);
    if (binary == null || ![this.binaryPath(), managedBinaryPath(this.memberHomeDir(), process.platform), recorded].includes(binary) && !this.takesOver(binary)) return false;
    if (typeof server.url === 'string') {
      const helper = this.canonicalHelper(server);
      const deployment = this.entryDeployment(server);
      return helper?.source === 'registry' && deployment !== null && helper.deployment === deployment
        && readDeploymentMembershipResult(deployment, this.memberHomeDir()).status === 'present';
    }
    return this.declaresUsableCredential(server) && parseCredentialFlag(this.launcherArgv(server) ?? []) === 'registry';
  }

  private privateMcpRouting(): boolean {
    if (this.manifest.registration?.memberMcpRouting !== 'private-projects') return false;
    return this.multipleMcpDeployments() || privateMcpProjects(this.readMemberMcpTarget() ?? {}).some(scope => this.ownPrivateMcp(scope.entry));
  }

  private ownPrivateMcp(entry: unknown): boolean {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const server = entry as Record<string, unknown>;
    return server.url === undefined && this.launcherArgv(server)?.includes(MCP_ROOT_FLAG) === true && this.ownRoutedMcp(server);
  }

  private canReplaceGlobalMcp(entry: unknown): boolean {
    return this.ownRoutedMcp(entry) || this.legacyHomes.length > 0 && mcpVerdict(entry, this.legacyHomes) === 'legacy';
  }

  private privateMcpPlan(remove = false, leavingDeployment?: string): Record<string, unknown> {
    const data = this.readMemberMcpTarget() ?? {};
    const read = listRegistryEntriesResult(this.memberHomeDir());
    if (!read.readable || read.unavailableEntries > 0 || read.conflicts?.length) throw this.memberMcpConflict('the project connections could not all be read', 'Restore access to the project connection files');
    const candidates = new Set(read.entries.flatMap(entry => [entry.root, ...(entry.displayRoot ? [entry.displayRoot] : [])]));
    for (const scope of privateMcpProjects(data)) if (this.ownPrivateMcp(scope.entry)) candidates.add(scope.root);
    if (!this.noProjectRoot) candidates.add(this.projectRoot);
    if (this.projectFolder !== undefined) candidates.add(this.projectFolder);
    const roots = remove ? [] : [...new Set([...candidates].map(root => resolveMemberProjectRoot(root)))].filter(root => {
      const binding = readRegistryEntryResult(resolveMemberProjectRoot(root), this.memberHomeDir());
      if (binding.status === 'unavailable') throw this.memberMcpConflict(`the project connection for ${root} is unavailable`, 'Restore its connection');
      return binding.status === 'present' && (leavingDeployment === undefined || deploymentUrl(binding.entry.serverUrl) !== deploymentUrl(leavingDeployment));
    });
    try {
      const global = data.mcpServers as Record<string, unknown> | undefined;
      if (global?.[MYCO_MCP_SERVER_NAME] !== undefined && !this.canReplaceGlobalMcp(global[MYCO_MCP_SERVER_NAME]))
        this.assertMcpDeploymentConnected(global[MYCO_MCP_SERVER_NAME], this.memberMcpTargetPath()!, 'mcpServers');
      const multiple = this.multipleMcpDeployments();
      const next = reconcilePrivateMcpProjects(data, remove || !multiple ? [] : roots, root => ({
        type: 'stdio', command: this.binaryPath(), args: [...MEMBER_BRIDGE_ARGS, CREDENTIAL_FLAG, 'registry', MCP_ROOT_FLAG, root], ...MEMBER_MCP_LEVERS,
      }), { local: entry => this.ownPrivateMcp(entry), global: entry => this.canReplaceGlobalMcp(entry) });
      const members = listDeploymentMembershipsResult(this.memberHomeDir());
      if (!remove && !multiple && members.memberships.length === 1) {
        next.mcpServers = { ...(next.mcpServers as Record<string, unknown> | undefined), ...this.renderMemberMcp('registry', members.memberships[0].serverUrl) };
      }
      return next;
    } catch (error) {
      if (error instanceof MemberMcpConflictError) throw error;
      throw this.memberMcpConflict(error instanceof Error ? error.message : String(error), 'Review the affected tools entry');
    }
  }

  private memberHomeDir(): string {
    return this.memberHome ?? resolveMycoHome({ cwd: this.projectRoot });
  }

  private assertMcpDeploymentConnected(entry: unknown, target: string, serversKey: string): void {
    if (!this.isMemberMcpServer(entry)) return;
    const other = this.entryDeployment(entry as Record<string, unknown>);
    if (other === null) return;
    const memberships = listDeploymentMembershipsResult(this.memberHomeDir());
    if (!memberships.readable || memberships.unavailableEntries > 0
      || memberships.memberships.some(member => deploymentUrl(member.serverUrl) === other && !member.refreshTerminal)) return;
    this.assertDeploymentLogoutFinished(other);
    const home = process.env.HOME ?? os.homedir();
    const file = target.startsWith(home + path.sep) ? '~' + target.slice(home.length) : target;
    const toolsRecovery = { address: other, file, entry: `${serversKey}.${MYCO_MCP_SERVER_NAME}` };
    const problem = `${this.manifest.displayName}'s Myco tools point at ${other}; this machine is no longer connected there.`;
    const repairAction = `${this.manifest.displayName}'s Myco tools point at a Myco this machine is no longer connected to. Open myco doctor on that machine for its address and reconnection steps.`;
    throw new MemberMcpConflictError(problem, toolsRecoveryRemedy(toolsRecovery), { repairAction, toolsRecovery });
  }

  private binaryPath(): string {
    return resolveManagedBinaryPath(this.memberHomeDir());
  }

  private memberMcpConflict(problem: string, remedy: string, cause?: unknown): MemberMcpConflictError {
    return new MemberMcpConflictError(
      `${problem}, so nothing was written`,
      `${remedy}, then run \`myco member provision ${this.manifest.name}\`.`,
      { cause },
    );
  }

  private memberMcpTargetPath(): string | null {
    const target = this.resolveAbsoluteMcpTargets()[0]?.path ?? null;
    return target === null ? null : throughLink(target);
  }

  installMemberMcp(scan = this.scanMemberRegistrations()): boolean {
    const toolsDeployment = this.assertMemberMcpWritable(scan);
    if (this.privateMcpRouting()) {
      const data = this.privateMcpPlan();
      return this.writeRegistrationTarget(this.memberMcpTargetPath(), 'mcp', scan, target => writeJsonFile(target, data));
    }
    const block = this.renderMemberMcp('registry', toolsDeployment);
    if (block === null) return false;
    return this.writeRegistrationTarget(this.memberMcpTargetPath(), 'mcp', scan, (targetPath) => {
      const reg = this.manifest.registration!;
      return this.withWritableMcpEntry(this.mycoServerIn(targetPath, reg.mcpFormat === 'toml', reg.mcpFormat === 'toml' ? TOML_MCP_SERVERS_KEY : reg.mcpServersKey ?? 'mcpServers'), () => {
        // A TOML server list (Codex) is edited section by section; the JSON sweep
        // below is for the JSON targets. The JSON hosts' levers are not written.
        // Codex's remote entry needs no `cwd`: it runs the headers helper in the
        // session's directory, where the membership resolves the way every hook's does.
        if (reg.mcpFormat === 'toml') return this.installMcpToml(targetPath, tomlMemberServers(block, this.sessionMcpRouting() ? undefined : this.projectRoot));
        const serversKey = reg.mcpServersKey ?? 'mcpServers';
        const data = this.readMemberMcpTarget() ?? {};
        for (const candidateKey of KNOWN_MCP_SERVERS_KEYS) {
          if (candidateKey === serversKey) continue;
          const candidate = data[candidateKey];
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
          const bag = candidate as Record<string, unknown>;
          this.withWritableMcpEntry(bag[MYCO_MCP_SERVER_NAME], () => {
            const binary = ownedMcpBinary(bag[MYCO_MCP_SERVER_NAME]);
            const legacy = this.legacyHomes.length > 0 && mcpVerdict(bag[MYCO_MCP_SERVER_NAME], this.legacyHomes) === 'legacy';
            if (this.takeOverManagedEntries && binary !== this.binaryPath() && !this.takesOver(binary) && !legacy) return;
            delete bag[MYCO_MCP_SERVER_NAME];
            if (Object.keys(bag).length === 0) delete data[candidateKey];
          });
        }
        const servers = (data[serversKey] ?? {}) as Record<string, unknown>;
        for (const [name, def] of Object.entries(block)) servers[name] = def;
        data[serversKey] = servers;
        return writeJsonFile(targetPath, data);
      }) ?? false;
    });
  }

  uninstallMemberMcp(): boolean {
    if (this.privateMcpRouting()) {
      const target = this.memberMcpTargetPath();
      return target !== null && writeJsonFile(target, this.privateMcpPlan(true));
    }
    if (this.preserveOtherMemberTools && this.memberToolsDeployment() !== undefined) return false;
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
      this.withWritableMcpEntry(bag[MYCO_MCP_SERVER_NAME], () => {
        if (!this.isMemberMcpServer(bag[MYCO_MCP_SERVER_NAME])) return;
        delete bag[MYCO_MCP_SERVER_NAME];
        removed = true;
        if (Object.keys(bag).length === 0) delete data[key];
      });
    }
    if (!removed) return false;
    this.writeMemberJson(targetPath, data, this.readOwnedSettingsAudit()?.file as SettingsFileAudit | undefined);
    return true;
  }

  reconcileMemberProjectMcp(): boolean {
    return (this.privateMcpRouting() || this.sessionMcpRouting() || this.manifest.registration?.memberMcpRouting === 'client-roots') && this.installMemberMcp();
  }

  memberMcpProjectFolders(): { status: 'readable'; folders: string[] } | { status: 'unreadable'; detail: string } {
    try {
      return { status: 'readable', folders: this.manifest.registration?.memberMcpRouting === 'private-projects'
        ? privateMcpProjects(this.readMemberMcpTarget() ?? {}).filter(scope => this.ownPrivateMcp(scope.entry)).map(scope => scope.root) : [] };
    } catch (error) {
      return { status: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private isMemberMcpServer(def: unknown): boolean {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return false;
    const server = def as Record<string, unknown>;
    const helperKey = this.manifest.registration?.memberMcpHeadersHelperKey;
    if (helperKey && typeof server[helperKey] === 'string' && server[helperKey].includes(CREDENTIAL_FLAG)) return true;
    return [server.command, server.args].some((list) => Array.isArray(list) && list.includes(CREDENTIAL_FLAG));
  }

  private readMemberFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (!isFileSystemError(error)) throw error;
      throw new MemberFileReadRefusal(filePath, error, this.manifest.name);
    }
  }

  private readMcpFile(filePath: string, toml: boolean): Record<string, unknown> | null {
    const raw = this.readMemberFile(filePath);
    if (raw === null) return null;
    try {
      const parsed: unknown = toml ? structuredClone(parseToml(raw)) : JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('expected a configuration object');
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TomlError)) throw error;
      throw new MemberFileReadRefusal(filePath, error, this.manifest.name);
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
    if (argv === null) return false;
    const rootIndex = argv.indexOf(MCP_ROOT_FLAG);
    if (rootIndex !== -1) {
      if (rootIndex !== MEMBER_BRIDGE_ARGS.length + CREDENTIAL_ARGV_WORDS || argv.length !== rootIndex + ROOT_ARGV_WORDS) return false;
      try { mcpProjectFolder(argv, this.projectRoot); } catch { return false; }
    } else if (argv.length !== MEMBER_BRIDGE_ARGS.length + CREDENTIAL_ARGV_WORDS
      && !(argv.length === MEMBER_BRIDGE_ARGS.length + CREDENTIAL_ARGV_WORDS + 1 && argv.at(-1) === MCP_CLIENT_ROOTS_FLAG)) return false;
    if (argv.slice(0, MEMBER_BRIDGE_ARGS.length).join(' ') !== MEMBER_BRIDGE_ARGS.join(' ')) return false;
    return parseCredentialFlag(argv.slice(MEMBER_BRIDGE_ARGS.length, MEMBER_BRIDGE_ARGS.length + CREDENTIAL_ARGV_WORDS)) !== null;
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

  inspectMemberHooks(): { scope: 'global'; target: string | null; present: boolean; member: boolean; memberCommands: string[]; readable: boolean } {
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
      return { ...none, present, member: present && pluginFileVerdict(raw, this.legacyHomes, this.memberHomeDir()) !== 'stale' && raw.includes(MEMBER_PLUGIN_MARKER), readable: true };
    }
    const memberCommands = hookCommandsIn(raw)
      .filter((command) => this.managesHook(command) && parseCredentialFlag(command.split(/\s+/)) !== null);
    return { ...none, present, member: present && memberCommands.length > 0, memberCommands, readable: true };
  }

  inspectMemberMcp(expectedDeployment?: string, includeDestination = false): MemberMcpInspection[] {
    const toml = this.manifest.registration?.mcpFormat === 'toml';
    return this.resolveAbsoluteMcpTargets().map(({ path: filePath, serversKey }) => {
      let configPath = filePath;
      let scope: MemberMcpInspection['scope'] = 'global';
      let trusted: boolean | undefined;
      let shadowed: boolean | undefined;
      // A TOML host keeps its servers under one section whatever the manifest names.
      const key = toml ? TOML_MCP_SERVERS_KEY : serversKey;
      let file: Record<string, unknown> | null;
      try {
        file = this.readMcpFile(filePath, toml);
        if (!this.noProjectRoot && this.manifest.registration?.memberMcpRouting === 'private-projects') {
          const local = privateMcpProjects(file ?? {}).find(project => path.resolve(project.root) === path.resolve(resolveMemberProjectRoot(this.projectFolder ?? this.projectRoot)));
          if (local?.entry !== undefined) {
            file = { [key]: { [MYCO_MCP_SERVER_NAME]: local.entry } };
            scope = 'local';
            trusted = local.trusted;
          }
        }
        if (!this.noProjectRoot && scope === 'global' && this.manifest.registration?.memberMcpRouting !== undefined) {
          const projectTarget = this.manifest.registration.mcpTarget;
          const override = projectTarget === undefined ? null : this.readMcpFile(path.join(this.projectFolder ?? this.projectRoot, projectTarget), toml);
          const servers = override?.[key];
          if (servers && typeof servers === 'object' && MYCO_MCP_SERVER_NAME in servers) {
            file = override;
            configPath = path.join(this.projectFolder ?? this.projectRoot, projectTarget!);
            scope = 'project';
            shadowed = true;
          }
        }
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
      const argv = this.launcherArgv(entry);
      const explicitRoot = argv?.includes(MCP_ROOT_FLAG) === true;
      const declaredCwd = explicitRoot && this.declaresUsableCredential(entry) ? mcpProjectFolder(argv!, this.projectRoot)
        : typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : null;
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
      return {
        scope, present: true, transport, carriesCredential: this.declaresUsableCredential(entry), declaredCwd,
        deploymentsAgree, namesExpectedDeployment, readable: true,
        ...(trusted === undefined ? {} : { trusted }), ...(shadowed === undefined ? {} : { shadowed }),
        ...(scope === 'global' && transport === 'stdio' && this.manifest.registration?.memberMcpRouting === 'session-cwd' && declaredCwd === null ? { sessionCwd: true } : {}),
        ...(includeDestination && dialled !== null ? { configuredDeployment: dialled } : {}),
        ...(includeDestination ? { configPath, context: scope === 'local' ? 'explicit-folder' as const
          : transport === 'http' ? 'fixed-deployment' as const
            : argv?.includes(MCP_CLIENT_ROOTS_FLAG) ? 'client-roots' as const
            : scope === 'global' && this.manifest.registration?.memberMcpRouting === 'session-cwd' ? 'session-cwd' as const : 'launch-cwd' as const } : {}),
      };
    });
  }

  private assertMemberMcpWritable(scan: MemberRegistrationScan): string | undefined {
    this.preflightMemberSettings();
    this.readMemberMcpTarget();
    return this.assertGlobalMemberOwnership(undefined, scan);
  }

  private finishMemberInstall(result: InstallResult): InstallResult {
    if (!this.preserveOtherMemberTools) this.recordMemberProvision(getPluginVersion());
    return result;
  }

  recordMemberProvision(version: string): void {
    const serverUrl = readRegistryEntry(this.projectRoot, this.memberHomeDir())?.serverUrl ?? this.deploymentUrl;
    if (serverUrl !== undefined) recordProvision(this.memberHomeDir(), { version, serverUrl, agents: [this.manifest.name], binaries: { [this.manifest.name]: this.binaryPath() } });
  }

  private legacyHomes: readonly string[] = [];
  private takeOverManagedEntries = false;

  takingOverManagedEntries(): this {
    this.takeOverManagedEntries = true;
    return this;
  }

  private takesOver(binary: string | undefined): boolean {
    return binary !== this.binaryPath() && this.takeOverManagedEntries && mayTakeOverBinary(binary, this.memberHomeDir());
  }

  private takesOverFinding(finding: LegacyFinding & { replacementBinary?: string }): boolean {
    return this.takesOver(finding.replacementBinary ?? findingOwnedBinary(finding));
  }

  private leavingDeployment: string | undefined;
  private expectedServerUrl: string | undefined;
  private deploymentUrl: string | undefined;
  private noProjectRoot = false;
  private projectFolder?: string;
  private preserveOtherMemberTools = false;

  preservingOtherMemberTools(): this {
    this.preserveOtherMemberTools = true;
    return this;
  }

  memberToolsDeployment(scan = this.scanMemberRegistrations()): string | undefined {
    return this.assertGlobalMemberOwnership(undefined, scan);
  }

  withoutProjectRoot(): this {
    this.noProjectRoot = true;
    return this;
  }

  forProjectFolder(folder: string | undefined): this {
    if (folder !== undefined) this.projectFolder = path.resolve(folder);
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
    const scan = this.scanMemberRegistrations();
    if (!keepHooks) {
      this.assertMemberFilesReadable();
      this.assertGlobalMemberOwnership('hooks', scan);
    }
    this.forDeployment(nextDefault ?? leavingUrl).replacingDeployment(leavingUrl);
    if (keepHooks) this.reconcileRetiredHookSettings(scan);
    else this.migrateRetiredHookSettings(scan);
    this.reconcileDeploymentMcp(leavingUrl, nextDefault, !keepHooks, scan);
    if (!keepHooks) {
      this.assertGlobalMemberOwnership('hooks', scan);
      this.uninstallMemberHooks();
      this.uninstallSettings();
    }
  }

  private reconcileDeploymentMcp(leavingUrl: string, nextDefault: string | null, removeUnscoped: boolean, scan: MemberRegistrationScan): void {
    if (this.privateMcpRouting()) {
      this.assertGlobalMemberOwnership('hooks', scan);
      const target = this.memberMcpTargetPath();
      const data = this.privateMcpPlan(false, leavingUrl);
      if (target !== null) writeJsonFile(target, data);
      return;
    }
    if (this.manifest.registration?.memberMcpRouting === 'session-cwd' && nextDefault !== null && !this.multipleMcpDeployments()) {
      const target = this.memberMcpTargetPath();
      const entry = target === null ? null : this.mycoServerIn(target, true, TOML_MCP_SERVERS_KEY);
      if (entry !== null && entry.url === undefined && this.ownRoutedMcp(entry)) {
        this.installMemberMcp(scan);
        return;
      }
    }
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
        this.withWritableMcpEntry(server, () => {
          const dialled = this.entryDeployment(server);
          const minted = this.helperDeployment(server);
          const unscoped = dialled === null && minted === null && removeUnscoped && this.isMemberMcpServer(server);
          if (!unscoped && dialled !== deploymentUrl(leavingUrl) && minted !== deploymentUrl(leavingUrl)) return;
          if (dialled !== minted) throw this.memberMcpConflict(`the Myco MCP entry in ${target.path} names conflicting Deployments`, 'Fix the entry');
          this.assertGlobalMemberOwnership({ path: target.path, serversKey: key }, scan);
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
        });
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
        this.writeMemberJson(target.path, file, this.readOwnedSettingsAudit()?.file as SettingsFileAudit | undefined);
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

  memberGlobalTargets(scan = this.scanMemberRegistrations()): { hooks: string | null; mcp: string[]; all: string[]; skipped: string[]; blocked: MemberRegistrationScan } {
    const hookTarget = this.resolveAbsoluteTarget('hooks');
    const hooks = this.blocksRegistration(hookTarget, 'hooks', scan) ? null : hookTarget;
    const written = this.memberMcpTargetPath();
    const mcp = written === null || this.blocksRegistration(written, 'mcp', scan) ? [] : [written];
    const all = [hooks, ...mcp, this.resolveAbsoluteTarget('settings')];
    const blocked = this.blockedRegistrations(scan);
    const skipped = blocked.map(finding => staleRegistrationWords(finding, this.manifest.displayName, true));
    return { hooks, mcp, all: [...new Set(all.filter((file): file is string => file !== null))], skipped, blocked };
  }

  scanMemberRegistrations(): MemberRegistrationScan {
    return scanLegacyRegistrations({ homeDir: process.env.HOME ?? os.homedir(), legacyHomes: this.legacyHomes, ownHome: this.memberHomeDir(), allClaudeProjects: true })
      .findings.filter(finding => finding.location.agent === this.manifest.name).map(finding => ({ ...finding, target: throughLink(finding.file), replacementBinary: findingOwnedBinary(finding) })).filter(finding => finding.verdict === 'stale' || this.takesOverFinding(finding));
  }

  private blocksRegistration(target: string | null, surface: 'hooks' | 'mcp' | 'settings', scan: MemberRegistrationScan): boolean {
    return scan.some(finding => !this.takesOverFinding(finding) && finding.target === target && (surface === 'hooks' ? this.isMemberPluginFile() : surface === 'mcp'
      && finding.location.kind === 'mcp' && finding.serversPath?.length === 1
      && finding.serversPath[0] === (this.manifest.registration?.mcpFormat === 'toml' ? TOML_MCP_SERVERS_KEY : this.manifest.registration?.mcpServersKey ?? 'mcpServers')));
  }

  private blockedRegistrations(scan: MemberRegistrationScan): MemberRegistrationScan {
    return scan.filter(finding => this.blocksRegistration(finding.target, finding.location.kind === 'mcp' ? 'mcp' : 'hooks', [finding])
      && finding.target === (finding.location.kind === 'mcp' ? this.memberMcpTargetPath() : this.resolveAbsoluteTarget('hooks')));
  }

  staleRegistrationMessages(scan: MemberRegistrationScan): string[] {
    const blocked = this.blockedRegistrations(scan);
    const replacements = new Map<string, { file: string; surface: string; count: number; binaries: Set<string> }>();
    const notices = scan.flatMap(finding => {
      const target = finding.location.kind === 'mcp' ? this.memberMcpTargetPath() : this.resolveAbsoluteTarget('hooks');
      const globalEntry = finding.serversPath === undefined || finding.serversPath.length === 1;
      if (this.takesOverFinding(finding) && finding.target === target && globalEntry) {
        const surface = finding.location.kind === 'mcp' ? 'tools entry' : finding.keyPath === 'plugin' ? 'plugin' : 'hook';
        const key = `${finding.file}\0${surface}`;
        const group = replacements.get(key) ?? { file: finding.file, surface, count: 0, binaries: new Set<string>() };
        group.count++;
        group.binaries.add(finding.replacementBinary!);
        replacements.set(key, group);
        return [];
      }
      return finding.verdict === 'stale' ? [staleRegistrationWords(finding, this.manifest.displayName, blocked.includes(finding))] : [];
    });
    const home = process.env.HOME ?? os.homedir();
    const displayPath = (file: string) => file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
    const replaced = [...replacements.values()].map(group => `${this.manifest.displayName}: replaced ${group.count} Myco ${group.surface === 'tools entry' && group.count !== 1 ? 'tools entries' : group.surface + (group.count === 1 ? '' : 's')} in ${displayPath(group.file)} (were ${[...group.binaries].map(displayPath).join(', ')}).`);
    return [...replaced, ...notices];
  }

  private managesHook(command: string): boolean {
    return isMycoHookCommand(command) && (this.takesOver(ownedHookBinary(command)) || commandVerdict(command, this.legacyHomes) !== 'stale');
  }

  private withWritableMcpEntry<T>(entry: unknown, write: () => T): T | undefined {
    return !this.takesOver(ownedMcpBinary(entry)) && mcpVerdict(entry, this.legacyHomes) === 'stale' ? undefined : write();
  }

  private writeRegistrationTarget(target: string | null, surface: 'hooks' | 'mcp' | 'settings', scan: MemberRegistrationScan, write: (target: string) => boolean): boolean {
    return target === null || this.blocksRegistration(target, surface, scan) ? false : write(target);
  }

  memberRegistrationPresent(scan = this.scanMemberRegistrations()): boolean {
    this.assertGlobalMemberOwnership(undefined, scan);
    const target = this.resolveAbsoluteTarget('hooks');
    if (target !== null && fs.existsSync(target)) {
      if (this.isMemberPluginFile()) {
        const content = fs.readFileSync(target, 'utf8');
        if (!this.blocksRegistration(target, 'hooks', scan) && !this.takesOver(ownedPluginBinary(content)) && content.includes(MEMBER_PLUGIN_MARKER)) return true;
      } else if (hookCommands(this.readMcpFile(target, false)?.hooks).some((command) => !this.takesOver(ownedHookBinary(command)) && this.managesHook(command) && parseCredentialFlag(command.split(/\s+/)) === 'registry')) return true;
    }
    const mcp = this.memberMcpTargetPath();
    if (mcp === null) return false;
    const toml = this.manifest.registration?.mcpFormat === 'toml';
    const existing = this.mycoServerIn(mcp, toml, toml ? TOML_MCP_SERVERS_KEY : (this.manifest.registration?.mcpServersKey ?? 'mcpServers'));
    return existing !== null && !this.takesOver(ownedMcpBinary(existing)) && this.withWritableMcpEntry(existing, () => this.isMemberMcpServer(existing)) === true;
  }

  memberRegistrationCurrent(scan = this.scanMemberRegistrations(), allowStaleTools = false): boolean {
    if (!this.memberRegistrationPresent(scan)) return false;
    const toolsDeployment = this.assertGlobalMemberOwnership(undefined, scan);
    const blocked = this.blockedRegistrations(scan);
    if (blocked.some(finding => !allowStaleTools || finding.location.kind !== 'mcp')) return false;
    if (!this.memberSettingsCurrent()) return false;
    const target = this.resolveAbsoluteTarget('hooks');
    if (target === null || !fs.existsSync(target)) return false;
    if (this.isMemberPluginFile()) {
      if (fs.readFileSync(target, 'utf8') !== this.renderMemberPlugin('registry')) return false;
    } else {
      const hooks = this.readMcpFile(target, false)?.hooks;
      const managed = Object.fromEntries(Object.entries((hooks ?? {}) as Record<string, Record<string, unknown>[]>).flatMap(([event, groups]) => {
        const owned = groups.filter(group => hookCommands(group).some(command => this.managesHook(command))).map(group => managedHookGroup(group, command => this.managesHook(command)));
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
    if (this.privateMcpRouting()) return isDeepStrictEqual(this.readMemberMcpTarget() ?? {}, this.privateMcpPlan());
    const targetMcp = this.memberMcpTargetPath();
    const desired = this.renderMemberMcp('registry', toolsDeployment);
    if (targetMcp === null || desired === null || (allowStaleTools && blocked.length > 0)) return true;
    const toml = this.manifest.registration?.mcpFormat === 'toml';
    const expected = (toml ? tomlMemberServers(desired, this.sessionMcpRouting() ? undefined : this.projectRoot) : desired)[MYCO_MCP_SERVER_NAME] as Record<string, unknown>;
    const existing = this.mycoServerIn(targetMcp, toml, toml ? TOML_MCP_SERVERS_KEY : (this.manifest.registration?.mcpServersKey ?? 'mcpServers'));
    return existing !== null && Object.entries(expected).every(([key, value]) => isDeepStrictEqual(existing[key], value));
  }

  private retiredSettingsPlan(): { target: string; text: string; changed: boolean; conflicts: RetiredSettingsConflict[] } | null {
    const reg = this.manifest.registration;
    const target = this.resolveAbsoluteTarget('hooks');
    if (target === null || reg?.hooksContainSettings || !reg?.retiredHookSettings) return null;
    const raw = this.readMemberFile(target);
    if (raw === null) return null;
    try {
      const { text, conflicts } = retiredHookSettings(raw, reg.retiredHookSettings);
      return { target, text, changed: text !== raw, conflicts };
    } catch (error) {
      if (error instanceof RetiredHookSettingsParseError) throw new MemberRetiredSettingsRefusal(target, error);
      throw error;
    }
  }

  private retiredSettingsReportPath(): string {
    return path.join(this.memberHomeDir(), 'installer-audit', `${this.manifest.name}-retired-hook-settings.json`);
  }

  private retiredSettingsReported(): RetiredSettingsReport {
    try {
      const report: unknown = JSON.parse(fs.readFileSync(this.retiredSettingsReportPath(), 'utf8'));
      if (Array.isArray(report) && report.every(key => typeof key === 'string')) return { values: {} };
      if (report === null || typeof report !== 'object' || !('values' in report)
        || report.values === null || typeof report.values !== 'object' || Array.isArray(report.values)
        || !Object.values(report.values).every(hashes => Array.isArray(hashes) && hashes.every(hash => typeof hash === 'string'))
        || 'problem' in report && typeof report.problem !== 'string') throw new SyntaxError('Invalid retired settings report');
      return report as RetiredSettingsReport;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {} };
      if (!(error instanceof SyntaxError) && !isFileSystemError(error)) throw error;
      throw new MemberRetiredSettingsRefusal(this.retiredSettingsReportPath(), error);
    }
  }

  private writeRetiredSettingsReport(report: RetiredSettingsReport): void {
    const file = this.retiredSettingsReportPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(report) + '\n');
  }

  reportRetiredSettingsProblem(error: unknown, report: (message: string) => void = console.warn): void {
    const file = this.resolveAbsoluteTarget('hooks');
    const refusal = error instanceof MemberRetiredSettingsRefusal ? error : new MemberRetiredSettingsRefusal(file ?? this.manifest.name, error);
    try {
      const saved = this.retiredSettingsReported();
      if (saved.problem === refusal.message) return;
      this.writeRetiredSettingsReport({ ...saved, problem: refusal.message });
    } catch (diagnosticError) {
      report(`${this.manifest.displayName}: ${refusal.message} Could not record this problem (${firstLine(diagnosticError)}).`);
      return;
    }
    report(`${this.manifest.displayName}: ${refusal.message}`);
  }

  migrateRetiredHookSettings(scan?: MemberRegistrationScan, beforeWrite?: (file: string) => void): boolean {
    if (!this.manifest.registration?.retiredHookSettings) return false;
    const plan = this.retiredSettingsPlan();
    if (plan === null || !plan.changed && plan.conflicts.length === 0) {
      const saved = this.retiredSettingsReported();
      if (saved.problem !== undefined) {
        delete saved.problem;
        this.writeRetiredSettingsReport(saved);
      }
      return false;
    }
    const registrations = scan ?? this.scanMemberRegistrations();
    this.assertGlobalMemberOwnership('hooks', registrations);
    return this.writeRegistrationTarget(plan.target, 'hooks', registrations, target => {
      const saved = this.retiredSettingsReported();
      const pending = plan.conflicts.filter(({ key, hash }) => !saved.values[key]?.includes(hash));
      for (const { key, hash } of pending) {
        console.warn(`${this.manifest.displayName}: left user-changed ${key} in ${target}; review this setting manually.`);
        saved.values[key] = [...saved.values[key] ?? [], hash];
      }
      if (pending.length > 0 || saved.problem !== undefined) {
        delete saved.problem;
        this.writeRetiredSettingsReport(saved);
      }
      if (plan.changed) {
        beforeWrite?.(target);
        atomicWriteFileSync(target, plan.text);
      }
      return plan.changed;
    });
  }

  /** Reconcile retired output, reporting a refusal without blocking the caller's other work. */
  reconcileRetiredHookSettings(scan?: MemberRegistrationScan, beforeWrite?: (file: string) => void, report?: (message: string) => void): boolean | null {
    return isolateMemberFileRefusal(() => this.migrateRetiredHookSettings(scan, beforeWrite), error => this.reportRetiredSettingsProblem(error, report));
  }

  retiredHookSettingsCurrent(): boolean {
    const retired = this.retiredSettingsPlan();
    if (retired === null || !retired.changed && retired.conflicts.length === 0) return true;
    const saved = this.retiredSettingsReported();
    return !retired.changed && retired.conflicts.every(({ key, hash }) => saved.values[key]?.includes(hash));
  }

  private memberSettingsCurrent(): boolean {
    if (!this.retiredHookSettingsCurrent()) return false;
    const target = this.resolveAbsoluteTarget('settings');
    const template = this.loadTemplate('settings');
    if (target === null || template === null) return true;
    const existing = this.readMcpFile(target, this.manifest.registration?.settingsFormat === 'toml') ?? {};
    return isDeepStrictEqual(existing, deepMergeSettingsWithAudit(existing, template, emptyJsonAudit()));
  }

  globalOwnership(serverUrl: string, scan = this.scanMemberRegistrations()): { problem: string | null; replaces: string[] } {
    this.expectedServerUrl = serverUrl;
    try {
      this.assertMemberProvisionAllowed();
      this.assertGlobalMemberOwnership(undefined, scan);
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

  /** Hold repair to a pending logout destination only while its membership is missing. */
  assertMemberProvisionAllowed(): void {
    const record = readProvisionRecordStrict(this.memberHomeDir());
    const target = this.expectedServerUrl ?? this.deploymentUrl ?? record?.serverUrl;
    this.assertDeploymentLogoutFinished(target, record);
  }

  private assertDeploymentLogoutFinished(target: string | undefined, record = readProvisionRecordStrict(this.memberHomeDir())): void {
    const leaving = record?.pendingLogout?.[this.manifest.name]?.find(url => deploymentUrl(url) === deploymentUrl(target ?? ''));
    if (leaving !== undefined && readDeploymentMembershipResult(leaving, this.memberHomeDir()).status === 'missing') {
      throw new MemberPendingLogoutError(this.manifest.displayName, leaving);
    }
  }

  private assertGlobalMemberOwnership(targetOverride?: { path: string; serversKey: string } | 'hooks', scan: MemberRegistrationScan = this.scanMemberRegistrations()): string | undefined {
    const memberHome = this.memberHomeDir();
    const record = readProvisionRecord(memberHome);
    const ownBinaries = [this.binaryPath(), managedBinaryPath(memberHome, process.platform), ...(record?.binaries?.[this.manifest.name] ? [record.binaries[this.manifest.name]] : [])];
    if (isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, memberHome, { claimsHome: resolveClaimsHome() }) && !this.claimHeldByLegacyHome()) {
      throw new MemberProvisionConflictError('Global symbiont configuration is claimed by another installation.', 'Release its symbiont-config claim before provisioning globally.');
    }
    if (!this.noProjectRoot) {
      assertSafeProjectRoot(this.projectRoot);
    }
    const target = this.resolveAbsoluteTarget('hooks');
    if (target && fs.existsSync(target)) {
      if (this.isMemberPluginFile()) {
        const content = this.readMemberFile(target);
        if (content !== null) {
          const verdict = pluginFileVerdict(content, this.legacyHomes, memberHome);
          const replaceable = this.takesOver(ownedPluginBinary(content)) || verdict === 'stale' || verdict === 'member' || (verdict === 'legacy' && this.legacyHomes.length > 0);
          if (!replaceable) {
            throw new MemberProvisionConflictError(`Global hooks at ${target} belong to another installation.`, captureHolderNext(content.includes(MEMBER_PLUGIN_MARKER) || content.includes(CREDENTIAL_FLAG) ? 'member' : verdict));
          }
        }
      } else {
        const settings = this.readMcpFile(target, false);
        const commands = hookCommands(settings?.hooks)
          .filter((command) => !this.takesOver(ownedHookBinary(command)) && rawHasMycoOwnershipSignal(command) && commandVerdict(command, this.legacyHomes) !== 'stale' && !(this.legacyHomes.length > 0 && commandVerdict(command, this.legacyHomes) === 'legacy'));
        const foreign = commands.find((command) => parseCredentialFlag(command.split(/\s+/)) !== 'registry' || !ownBinaries.some((binary) => command.startsWith(`${binary} `)));
        if (foreign !== undefined) {
          throw new MemberProvisionConflictError(`Global hooks at ${target} belong to another installation (\`${foreign}\`).`, captureHolderNext(commandVerdict(foreign, this.legacyHomes)));
        }
      }
    }
    if (targetOverride === 'hooks') return;
    if (this.privateMcpRouting()) {
      this.privateMcpPlan();
      return;
    }
    const reg = this.manifest.registration;
    const mcpTarget = targetOverride?.path ?? this.memberMcpTargetPath();
    if (!mcpTarget) return;
    const existing = this.mycoServerIn(mcpTarget, reg?.mcpFormat === 'toml', targetOverride?.serversKey ?? (reg?.mcpFormat === 'toml' ? TOML_MCP_SERVERS_KEY : (reg?.mcpServersKey ?? 'mcpServers')));
    if (existing === null) return;
    if (this.blocksRegistration(mcpTarget, 'mcp', scan)) return;
    if (reg?.memberMcpRouting === 'client-roots') {
      if (!this.canReplaceGlobalMcp(existing) && !this.takesOver(ownedMcpBinary(existing))) {
        throw this.memberMcpConflict(`the global Myco MCP entry in ${mcpTarget} belongs to another installation`, MCP_OWNERSHIP_REMEDY);
      }
      return;
    }
    if (this.manifest.registration?.memberMcpRouting === 'session-cwd' && this.ownRoutedMcp(existing)
      && (this.sessionMcpRouting() || this.entryDeployment(existing) === null)) return;
    return this.withWritableMcpEntry(existing, () => {
      if (this.takesOver(ownedMcpBinary(existing))) return;
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
          const memberships = listDeploymentMembershipsResult(memberHome);
          const readable = memberships.readable && memberships.unavailableEntries === 0;
          const connected = memberships.memberships.some((membership) => deploymentUrl(membership.serverUrl) === other && !membership.refreshTerminal);
          if (readable && !connected) {
            const serversKey = targetOverride?.serversKey ?? (reg?.mcpFormat === 'toml' ? TOML_MCP_SERVERS_KEY : (reg?.mcpServersKey ?? 'mcpServers'));
            this.assertMcpDeploymentConnected(existing, mcpTarget, serversKey);
          }
          const heldElsewhere = other !== this.entryDeployment(desired ?? {}) && sameCredentialSource && this.helperDeployment(existing) === other
            && readable && connected;
          if (heldElsewhere && this.preserveOtherMemberTools) return other;
          const { problem, remedy } = readable && connected ? toolsStayOnDeploymentGuidance(this.manifest.displayName, other)
            : { problem: `${this.manifest.displayName}'s Myco tools point at ${other}, but this machine's Myco connections could not all be read.`, remedy: "Restore access to this machine's Myco connection files." };
          throw new MemberMcpConflictError(problem, remedy, { toolsDeployment: heldElsewhere ? other : undefined });
        }
        throw this.memberMcpConflict(`the global Myco MCP entry in ${mcpTarget} belongs to another installation or Deployment`, MCP_OWNERSHIP_REMEDY);
      }
    });
  }

  isMemberPluginFile(): boolean {
    const reg = this.manifest.registration;
    return reg?.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE && Boolean(reg.memberHooksTarget);
  }

  private writeMemberPlugin(scan: MemberRegistrationScan): boolean {
    const rendered = this.renderMemberPlugin('registry');
    if (rendered === null) return false;
    return this.writeRegistrationTarget(this.resolveAbsoluteTarget('hooks'), 'hooks', scan, (targetPath) => {
      this.assertMemberPluginTargetIsMyco(targetPath);
      const written = this.writeManagedFile(targetPath, rendered);
      return written;
    });
  }

  private assertMemberPluginTargetIsMyco(targetPath: string): void {
    let content: string;
    try {
      content = fs.readFileSync(targetPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new MemberPluginConflictError(
        `could not read ${targetPath} (${error instanceof Error ? error.message : String(error)}), so nothing was written.`,
        'Restore read access to this file.',
      );
    }
    if (content.includes(MYCO_PLUGIN_FILE_MARKER) || rawHasMycoOwnershipSignal(content)) return;
    throw new MemberPluginConflictError(
      `${targetPath} is not a Myco plugin, so nothing was written and it was left as it is.`,
      `Move it elsewhere if ${this.manifest.displayName} should load Myco's plugin here, then run \`myco member provision ${this.manifest.name}\`.`,
    );
  }

  assertMemberUninstallable(): void {
    this.assertMemberFilesReadable();
    this.assertGlobalMemberOwnership();
  }

  assertMemberFilesReadable(): void {
    this.preflightMemberSettings();
    const hooks = this.resolveAbsoluteTarget('hooks');
    if (hooks !== null) {
      if (this.isMemberPluginFile()) this.readMemberFile(hooks);
      else this.readMcpFile(hooks, false);
    }
    for (const target of this.resolveAbsoluteMcpTargets()) this.readMcpFile(throughLink(target.path), this.manifest.registration?.mcpFormat === 'toml');
  }

  uninstallMemberRegistration(): void {
    this.assertMemberUninstallable();
    this.migrateRetiredHookSettings();
    this.uninstallMemberHooks();
    this.uninstallMemberMcp();
    this.uninstallSettings();
  }

  uninstallMemberHooks(): boolean {
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (targetPath === null || !fs.existsSync(targetPath)) return false;
    if (this.isMemberPluginFile()) {
      // Only the member plugin: a 1.4 project plugin at the same path carries the generic marker alone.
      const content = this.readMemberFile(targetPath);
      if (content === null) return false;
      if (pluginFileVerdict(content, this.legacyHomes, this.memberHomeDir()) === 'stale' || !content.includes(MEMBER_PLUGIN_MARKER)) return false;
      fs.rmSync(targetPath, { force: true });
      return true;
    }
    const settings = this.readMcpFile(targetPath, false) ?? {};
    const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    const kept: Record<string, unknown[]> = {};
    let removed = false;
    for (const [event, groups] of Object.entries(existingHooks)) {
      const foreign = withoutMycoHooks(groups as Array<Record<string, unknown>>, command => this.managesHook(command) && command.includes(CREDENTIAL_FLAG));
      if (!isDeepStrictEqual(groups, foreign)) removed = true;
      if (foreign.length > 0) kept[event] = foreign;
    }
    if (!removed) return false;
    if (Object.keys(kept).length > 0) {
      settings.hooks = kept;
    } else {
      delete settings.hooks;
    }
    this.writeMemberJson(targetPath, settings, this.readOwnedSettingsAudit()?.file as SettingsFileAudit | undefined);
    return true;
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
    return this.withWritableMcpEntry(this.mycoServerIn(targetPath, true, TOML_MCP_SERVERS_KEY), () => {
      let original = '';
      try { original = fs.readFileSync(targetPath, 'utf-8'); } catch { /* doesn't exist */ }

      let raw = original;
      for (const [name, def] of Object.entries(template)) {
        const desired = def as Record<string, unknown>;
        const existing = this.mycoServerIn(targetPath, true, TOML_MCP_SERVERS_KEY);
        const sameKeys = existing !== null && Object.keys(existing).length === Object.keys(desired).length
          && Object.keys(existing).every(key => key in desired);
        const changes = Object.entries(desired).filter(([key, value]) => !isDeepStrictEqual(existing?.[key], value));
        const section = `${TOML_MCP_SERVERS_KEY}.${name}`;
        const canonicalLines = changes.every(([key]) => readTomlSectionKeyLine(raw, section, key)?.trim() === `${key} = ${JSON.stringify(existing?.[key])}`);
        const scalarValues = Object.values(desired).every(value => value === null || typeof value !== 'object' || Array.isArray(value));
        raw = sameKeys && scalarValues && canonicalLines
          ? upsertTomlSectionKeys(raw, section, Object.fromEntries(changes))
          : buildTomlMcpSection(raw, name, desired);
      }

      // Idempotency (mirrors installMcpJson): skip the write when the upsert
      // produced no change, so the detection tick doesn't churn a config.toml the
      // agent owns on every pass.
      if (isDeepStrictEqual(parseToml(raw), parseToml(original))) return false;

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      atomicWriteFileSync(targetPath, raw);
      return true;
    }) ?? false;
  }

  installSettings(scan = this.scanMemberRegistrations()): boolean {
    this.preflightMemberSettings();
    const reg = this.manifest.registration;
    if (!reg?.settingsTarget) return false;

    const template = this.loadTemplate('settings');
    if (!template) return false;

    // Plugin-file hook targets don't share their file with settings;
    // resolveAbsoluteTarget returns null in that case under global
    // scope so the settings template can't clobber the plugin source.
    return this.writeRegistrationTarget(this.resolveAbsoluteTarget('settings'), 'settings', scan, (targetPath) => {
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
      audit.file = this.settingsFileAudit();
      const merged = deepMergeSettingsWithAudit(existing, template, audit);
      // Merge with any pre-existing audit so re-installs accumulate
      // ownership claims (different template versions may legitimately
      // touch different paths over time). Paths are arrays; key on the
      // JSON-stringified form to avoid false-distinct paths.
      const existingAudit = this.readJsonSettingsAudit();
      if (existingAudit) {
        for (const s of existingAudit.scalars) {
          const current = audit.scalars.find(entry => JSON.stringify(entry.path) === JSON.stringify(s.path));
          if (current) {
            if (s.previous) current.previous = s.previous; else delete current.previous;
          } else audit.scalars.push(s);
        }
        const arrayByPath = new Map(audit.arrayEntries.map((e) => [JSON.stringify(e.path), e]));
        for (const e of existingAudit.arrayEntries) {
          const key = JSON.stringify(e.path);
          const current = arrayByPath.get(key);
          if (current) {
            if (e.previous) current.previous = e.previous; else delete current.previous;
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
      return this.writeAuditedSettings(audit, () => writeJsonFile(targetPath, merged));
    });
  }

  private getSettingsAuditPath(): string {
    const stateRoot = this.memberHomeDir();
    return path.join(stateRoot, 'installer-audit', `${this.manifest.name}-global-settings.json`);
  }

  private preflightMemberSettings(): void {
    const target = this.resolveAbsoluteTarget('settings');
    if (target === null) return;
    this.readMcpFile(target, this.manifest.registration?.settingsFormat === 'toml');
  }

  private readonly reportedAuditProblems = new Set<string>();

  private readOwnedSettingsAudit(): Record<string, unknown> | null {
    const file = this.getSettingsAuditPath();
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
      const segments = (item: unknown): boolean => Array.isArray(item) && item.length > 0
        && item.every(part => typeof part === 'string' && !['__proto__', 'constructor', 'prototype'].includes(part));
      const previous = (item: Record<string, unknown>, array = false): boolean => !Object.hasOwn(item, 'previous')
        || object(item.previous) && Object.hasOwn(item.previous, 'value') && (!array || Array.isArray(item.previous.value));
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !(value.schema === 1 && Array.isArray(value.wroteKeys) && value.wroteKeys.every((key: unknown) => typeof key === 'string')
          && (value.previousValues === undefined || object(value.previousValues))
          || value.schema === 2 && value.format === 'json'
          && Array.isArray(value.scalars) && value.scalars.every((entry: unknown) => object(entry) && segments(entry.path) && Object.hasOwn(entry, 'value') && previous(entry))
          && Array.isArray(value.arrayEntries) && value.arrayEntries.every((entry: unknown) => object(entry) && segments(entry.path) && Array.isArray(entry.values) && previous(entry, true)))) {
        throw new Error('Invalid settings audit');
      }
      if (value.schema === 1) {
        const prior = value.previousValues ?? {};
        if (Object.values(prior).some(item => !['boolean', 'string', 'number'].includes(typeof item))) throw new Error('Invalid prior settings');
        if (value.previousLines !== undefined) {
          if (!object(value.previousLines)) throw new Error('Invalid original settings lines');
          for (const [key, line] of Object.entries(value.previousLines)) {
            const dot = key.indexOf('.');
            if (typeof line !== 'string' || /[\r\n]/.test(line) || dot < 0 || !Object.hasOwn(prior, key)
              || !isDeepStrictEqual(readTomlSectionKey(`[${key.slice(0, dot)}]\n${line}\n`, key.slice(0, dot), key.slice(dot + 1)), prior[key])) {
              throw new Error('Invalid original settings line');
            }
          }
        }
      }
      if (value.file !== undefined) {
        if (!object(value.file) || typeof value.file.existed !== 'boolean'
          || value.file.trailingWhitespace !== undefined && (typeof value.file.trailingWhitespace !== 'string' || !/^\s*$/.test(value.file.trailingWhitespace))) throw new Error('Invalid file audit');
        if (value.file.emptyText !== undefined) {
          if (typeof value.file.emptyText !== 'string') throw new Error('Invalid empty-file audit');
          const empty = this.manifest.registration?.settingsFormat === 'toml' ? parseToml(value.file.emptyText) : JSON.parse(value.file.emptyText);
          if (!object(empty) || Object.keys(empty).length !== 0) throw new Error('Invalid empty-file audit');
        }
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (!this.reportedAuditProblems.has(file)) {
        console.warn(`Myco settings audit ${file} is unreadable or corrupt and owns no settings; install replaces it and uninstall deletes it.`);
        this.reportedAuditProblems.add(file);
      }
      return null;
    }
  }

  private settingsFileAudit(): SettingsFileAudit | undefined {
    const saved = this.readOwnedSettingsAudit()?.file as SettingsFileAudit | undefined;
    if (saved && typeof saved.existed === 'boolean') return saved;
    const target = this.resolveAbsoluteTarget('settings');
    if (target === null) return undefined;
    try {
      const raw = fs.readFileSync(target, 'utf8');
      const toml = this.manifest.registration?.settingsFormat === 'toml';
      const data = toml ? parseToml(raw) : JSON.parse(raw);
      return {
        existed: true,
        ...(Object.keys(data).length === 0 ? { emptyText: raw } : {}),
        ...(toml ? { trailingWhitespace: raw.match(/\s*$/)?.[0] ?? '' } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { existed: false };
    }
  }

  private writeSettingsAuditRecord(audit: object): void {
    const file = this.getSettingsAuditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(audit, null, 2) + '\n');
  }

  private readJsonSettingsAudit(): JsonSettingsAudit | null {
    const parsed = this.readOwnedSettingsAudit() as Partial<JsonSettingsAudit> | null;
    if (parsed?.schema !== 2 || parsed.format !== 'json') return null;
    return {
      schema: 2, format: 'json', file: parsed.file,
      scalars: (parsed.scalars ?? []).filter(entry => Array.isArray(entry.path) && entry.path.every(part => typeof part === 'string')),
      arrayEntries: (parsed.arrayEntries ?? []).filter(entry => Array.isArray(entry.path) && entry.path.every(part => typeof part === 'string') && Array.isArray(entry.values)),
    };
  }

  private writeAuditedSettings(audit: object, write: () => boolean): boolean {
    const previous = this.readOwnedSettingsAudit();
    this.writeSettingsAuditRecord(audit);
    try { return write(); } catch (error) {
      try {
        if (previous) this.writeSettingsAuditRecord(previous);
        else this.deleteSettingsAudit();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Settings write and audit recovery failed for ${this.getSettingsAuditPath()}`);
      }
      throw error;
    }
  }

  private deleteSettingsAudit(): void {
    const file = this.getSettingsAuditPath();
    try { fs.unlinkSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.writeSettingsAuditRecord(this.manifest.registration?.settingsFormat === 'toml'
        ? { schema: 1, wroteKeys: [] } : emptyJsonAudit());
      console.warn(`Could not delete Myco settings audit ${file}; replaced it with an empty audit that owns no settings.`);
    }
  }

  private writeMemberJson(target: string, data: Record<string, unknown>, file?: SettingsFileAudit): void {
    const settingsTarget = target === this.resolveAbsoluteTarget('settings');
    if (Object.keys(data).length === 0 && settingsTarget && file?.existed !== false) {
      atomicWriteFileSync(target, file?.emptyText ?? '{}\n');
    } else writeOrDeleteJsonFile(target, data);
  }

  private installSettingsToml(targetPath: string, template: Record<string, unknown>): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const original = raw;

    const saved = this.readOwnedSettingsAudit();
    const audit = new Set(saved?.schema === 1 ? saved.wroteKeys as string[] : []);
    const previousValues = { ...(saved?.previousValues as Record<string, unknown> ?? {}) };
    const previousLines = { ...(saved?.previousLines as Record<string, string> ?? {}) };
    const file = this.settingsFileAudit();
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
          if (!audit.has(auditKey) && currentVal !== undefined) {
            previousValues[auditKey] = currentVal;
            const line = readTomlSectionKeyLine(raw, sectionName, key);
            if (line !== undefined) previousLines[auditKey] = line;
          }
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
    return this.writeAuditedSettings({ schema: 1, wroteKeys: Array.from(audit).sort(), previousValues, previousLines, file }, () => {
      if (changed) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        atomicWriteFileSync(targetPath, raw);
      }
      return changed;
    });
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
    if (audit === null) { this.deleteSettingsAudit(); return false; }
    const declared = (segments: readonly string[]): boolean => segments.reduce<unknown>((value, key) =>
      value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined, template) !== undefined;
    const changed = removeAuditedSettings(settings, {
      ...audit,
      scalars: audit.scalars.filter(entry => declared(entry.path)),
      arrayEntries: audit.arrayEntries.filter(entry => declared(entry.path)),
    });
    if (changed) this.writeMemberJson(targetPath, settings, audit.file);
    this.deleteSettingsAudit();
    return changed;
  }

  private uninstallSettingsToml(targetPath: string, template: Record<string, unknown>): boolean {
    const saved = this.readOwnedSettingsAudit();
    const audit = saved?.schema === 1 ? saved.wroteKeys as string[] : [];
    const previousValues = saved?.previousValues as Record<string, unknown> ?? {};
    const previousLines = saved?.previousLines as Record<string, string> ?? {};
    const file = saved?.file as SettingsFileAudit | undefined;
    if (audit.length === 0) {
      this.deleteSettingsAudit();
      return false;
    }

    let raw = this.readMemberFile(targetPath) ?? '';

    // Only currently declared settings remain managed.
    const templateSections = new Set<string>();
    for (const [sectionName, values] of Object.entries(template)) {
      if (values && typeof values === 'object' && !Array.isArray(values)) {
        templateSections.add(sectionName);
      }
    }

    const bySection = new Map<string, string[]>();
    let restored = false;
    for (const entry of audit) {
      const dot = entry.indexOf('.');
      if (dot < 0) continue;
      const section = entry.slice(0, dot);
      const key = entry.slice(dot + 1);
      if (!templateSections.has(section)) continue;
      const values = template[section] as Record<string, unknown>;
      if (!Object.hasOwn(values, key) || !isDeepStrictEqual(readTomlSectionKey(raw, section, key), values[key])) continue;
      const bucket = bySection.get(section) ?? [];
      if (Object.hasOwn(previousValues, entry)) {
        const next = upsertTomlSectionKeys(raw, section, { [key]: previousValues[entry] }, { [key]: previousLines[entry] });
        restored ||= next !== raw;
        raw = next;
      } else bucket.push(key);
      bySection.set(section, bucket);
    }

    let changed = restored;
    for (const [sectionName, keys] of bySection) {
      const next = removeTomlSectionKeys(raw, sectionName, keys);
      if (next !== raw) {
        raw = next;
        changed = true;
      }
    }

    if (changed) {
      if (file?.trailingWhitespace !== undefined) raw = raw.replace(/\s*$/, file.trailingWhitespace);
      if (!raw.trim() && file?.existed === false) fs.unlinkSync(targetPath);
      else atomicWriteFileSync(targetPath, !raw.trim() && file?.emptyText !== undefined ? file.emptyText : raw);
    }

    this.deleteSettingsAudit();
    return changed;
  }

  private uninstallMcpToml(targetPath: string): boolean {
    return this.withWritableMcpEntry(this.mycoServerIn(targetPath, true, TOML_MCP_SERVERS_KEY), () => {
      const raw = this.readMemberFile(targetPath);
      if (raw === null) return false;

      const sectionHeader = `[mcp_servers.${MYCO_MCP_SERVER_NAME}]`;
      if (!raw.includes(sectionHeader)) return false;

      const startIdx = raw.indexOf(sectionHeader);
      const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, `mcp_servers.${MYCO_MCP_SERVER_NAME}`);
      const before = raw.slice(0, startIdx).trimEnd();
      const after = raw.slice(endIdx).trimStart();
      const updated = (before + (before && after ? '\n\n' : '') + after).trimEnd();

      if (!updated.trim()) {
        fs.unlinkSync(targetPath);
      } else {
        atomicWriteFileSync(targetPath, updated + "\n");
      }
      return true;
    }) ?? false;
  }

}
