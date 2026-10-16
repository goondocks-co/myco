/**
 * What a cutover keeps so every change it makes can be undone by hand, in
 * one folder of the 2.0 home and never beside the files, so a project's
 * working tree gains nothing.
 *
 * `<2.0 home>/backups/cutover-<stamp>/` mirrors each original's absolute path
 * for every file the cutover rewrites, removes or replaces (agent settings,
 * the 1.4 service unit, the claim files), each copy with the original's mode.
 * `manifest.json` lists every entry: a copy with its sha256, a file the
 * cutover created, or a link it removed or repointed with where it pointed.
 * `restore.md` holds the commands that undo them. A copy of a file the run
 * leaves unchanged is dropped once every change is made. Executable recovery
 * copies remain in the backup.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writePrivateFileAtomic } from './store.js';
import type { MycoUnit } from './legacy-unit-files.js';

export type LegacyExecutableRecovery =
  | { kind: 'present'; version: string | null; warnings: string[] }
  | { kind: 'saved'; source: string; sha256: string; version: string | null; warnings: string[] }
  | { kind: 'missing'; candidates: string[]; version: string | null; warnings: string[] };

export type BackupEntry =
  | { original: string; backup: string; sha256: string; task?: string }
  | { original: string; recovery: LegacyExecutableRecovery }
  | { original: string; created: true }
  | { original: string; link: string };

export const MANIFEST_FILE = 'manifest.json';
export const RESTORE_FILE = 'restore.md';
const FOLDER_PREFIX = 'cutover-';

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
const psQuote = (p: string): string => `'${p.replaceAll("'", "''")}'`;
const quote = (p: string): string => `'${p.replaceAll("'", "'\\''")}'`;

/** Where a cutover run's backups go. */
export const cutoverBackupDir = (mycoHome: string, stamp: string): string => path.join(mycoHome, 'backups', `${FOLDER_PREFIX}${stamp}`);

function readManifest(dir: string): BackupEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries as BackupEntry[] : [];
  } catch { return []; }
}

/** Whether an earlier cutover already holds a copy of `file` with exactly its current bytes. */
export function earlierCopyHolds(mycoHome: string, file: string): boolean {
  const root = path.join(mycoHome, 'backups');
  let folders: string[];
  try { folders = fs.readdirSync(root).filter((n) => n.startsWith(FOLDER_PREFIX)); } catch { return false; }
  let digest: string;
  try { digest = sha256(fs.readFileSync(file)); } catch { return false; }
  return folders.some((folder) => readManifest(path.join(root, folder))
    .some((e) => 'sha256' in e && e.original === file && e.sha256 === digest && fs.existsSync(e.backup)));
}

/** What a backup folder undoes: a cutover from 1.4, or a member provisioning of this machine's agents. */
export type BackupPurpose = 'cutover' | 'provision';

function executableBlock(commands: string[], windows: boolean): string[] {
  return windows
    ? ['```powershell', '& {', "$ErrorActionPreference = 'Stop'", ...commands, '}', '```']
    : ['```sh', '(', 'set -e', ...commands, ')', '```'];
}

function replaceExecutableCommands(source: string, destination: string, preserveMode: boolean): string[] {
  return [
    'restore_binary=',
    `trap 'if [ -n "$restore_binary" ]; then rm -f "$restore_binary"; fi' EXIT`,
    `restore_binary=$(mktemp ${quote(path.join(path.dirname(destination), '.myco-restore-XXXXXX'))})`,
    `cp ${preserveMode ? '-p ' : ''}${source} "$restore_binary"`,
    ...(!preserveMode ? ['chmod +x "$restore_binary"'] : []),
    `mv -f "$restore_binary" ${quote(destination)}`,
  ];
}

function executableRecoveryRecipe(entries: readonly BackupEntry[], platform: NodeJS.Platform): string[] {
  const windows = platform === 'win32';
  const hashCommand = platform === 'linux' ? 'sha256sum' : 'shasum -a 256';
  return entries.flatMap(entry => {
    if (!('recovery' in entry)) return [];
    const { recovery, original } = entry;
    if (recovery.kind === 'present') return [...recovery.warnings, `The Myco 1.x executable is still in place at ${original}. No executable recovery is needed.`, ''];
    const preface = [...recovery.warnings, `Restoring the saved executable replaces Myco 2.0 at ${original}.`];
    if (recovery.kind === 'saved') {
      const commands = windows ? [
        `if ((Get-FileHash -LiteralPath ${psQuote(recovery.source)} -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${recovery.sha256}') { throw 'The saved executable checksum does not match.' }`,
        `Copy-Item -LiteralPath ${psQuote(recovery.source)} -Destination ${psQuote(original)} -Force -ErrorAction Stop`,
      ] : [
        `test "$(${hashCommand} ${quote(recovery.source)} | awk '{print $1}')" = '${recovery.sha256}' || { echo 'The saved executable checksum does not match.' >&2; exit 1; }`,
        ...replaceExecutableCommands(quote(recovery.source), original, true),
      ];
      return [...preface, '', ...executableBlock(commands, windows), ''];
    }
    if (recovery.candidates.length > 0) {
      return [...preface, recovery.version ? `The recorded previous version is ${recovery.version}. Its executable could not be identified. Saved executable candidates:`
          : 'The previous exact version was not recorded. Saved executable candidates:',
        ...recovery.candidates.map(file => `- ${file}`),
        `Choose the correct saved Myco 1.x executable and copy it to ${original} before starting the service. Do not start it with Myco 2.0.`, ''];
    }
    const version = recovery.version;
    const guidance = version ? `Reinstall Myco ${version} at ${original} before starting the service.`
      : `The previous exact version was not recorded. Reinstall the latest Myco 1.4 release at ${original} before starting the service.`;
    const base = 'https://github.com/goondocks-co/myco/releases/download/myco%2Fv';
    const refs = 'https://api.github.com/repos/goondocks-co/myco/git/matching-refs/tags/myco/v1.4.';
    const commands = windows ? [
      ...(version ? [`$version = ${psQuote(version)}`] : [
        `$candidates = @(Invoke-RestMethod ${psQuote(refs)} | ForEach-Object { if ($_.ref -match '^refs/tags/myco/v(1[.]4[.][0-9]+)$') { $Matches[1] } } | Sort-Object { [Version]$_ } -Descending)`,
        '$version = $null',
        'foreach ($candidate in $candidates) {',
        `  try { $release = Invoke-RestMethod ('https://api.github.com/repos/goondocks-co/myco/releases/tags/myco%2Fv' + $candidate) }`,
        '  catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { continue }; throw }',
        '  if (-not $release.draft -and -not $release.prerelease) { $version = $candidate; break }',
        '}',
        "if (-not $version) { throw 'No Myco 1.4 release was found.' }",
      ]),
      '$download = Join-Path ([System.IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())',
      'New-Item -ItemType Directory -Path $download | Out-Null',
      `$url = '${base}' + $version`,
      "$asset = 'myco-windows-x64.exe'",
      "Invoke-WebRequest ($url + '/' + $asset) -OutFile (Join-Path $download $asset)",
      "Invoke-WebRequest ($url + '/SHA256SUMS') -OutFile (Join-Path $download 'SHA256SUMS')",
      "$expected = (Get-Content (Join-Path $download 'SHA256SUMS') | ForEach-Object { if ($_ -match '^([a-fA-F0-9]{64})\\s+\\*?myco-windows-x64[.]exe$') { $Matches[1] } })",
      "if (-not $expected -or (Get-FileHash (Join-Path $download $asset) -Algorithm SHA256).Hash -ne $expected) { throw 'The downloaded executable checksum does not match.' }",
      `Copy-Item -LiteralPath (Join-Path $download $asset) -Destination ${psQuote(original)} -Force -ErrorAction Stop`,
    ] : [
      ...(version ? [`version=${quote(version)}`] : [
        'releases=$(mktemp -d)',
        `candidates=$(curl --proto '=https' --tlsv1.2 -fsSL ${quote(refs)} | grep -o '"refs/tags/myco/v1\\.4\\.[0-9]*"' | sed 's|"refs/tags/myco/v||;s|"||' | sort -t. -k3,3nr)`,
        'version=',
        'for candidate in $candidates; do',
        `  status=$(curl --proto '=https' --tlsv1.2 -sS -o "$releases/release.json" -w '%{http_code}' "https://api.github.com/repos/goondocks-co/myco/releases/tags/myco%2Fv$candidate")`,
        '  case "$status" in 200) ;; 404) continue ;; *) echo "Could not find the latest Myco 1.4 release (HTTP $status)" >&2; exit 1 ;; esac',
        `  if grep -q '"prerelease"[[:space:]]*:[[:space:]]*false' "$releases/release.json" && grep -q '"draft"[[:space:]]*:[[:space:]]*false' "$releases/release.json"; then version=$candidate; break; fi`,
        'done',
        `test -n "$version" || { echo 'No published Myco 1.4 release was found.' >&2; exit 1; }`,
      ]),
      'case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "Unsupported architecture" >&2; exit 1 ;; esac',
      `asset=myco-${platform === 'linux' ? 'linux' : 'darwin'}-$arch`,
      'download=$(mktemp -d)',
      `url=${quote(base)}"$version"`,
      "curl --proto '=https' --tlsv1.2 -fsSL \"$url/$asset\" -o \"$download/$asset\"",
      "curl --proto '=https' --tlsv1.2 -fsSL \"$url/SHA256SUMS\" -o \"$download/SHA256SUMS\"",
      `expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name {print $1}' "$download/SHA256SUMS")`,
      `test "\${#expected}" -eq 64 || { echo 'The downloaded executable checksum is missing or malformed.' >&2; exit 1; }`,
      `test "$(${hashCommand} "$download/$asset" | awk '{print $1}')" = "$expected" || { echo 'The downloaded executable checksum does not match.' >&2; exit 1; }`,
      ...replaceExecutableCommands('"$download/$asset"', original, false),
    ];
    return [...preface, 'No saved Myco 1.x executable could be identified.', guidance, '',
      ...executableBlock(commands, windows), ''];
  });
}

/** The commands that undo a cutover's (or a provisioning's) changes, newest first. */
export function restoreRecipe(entries: readonly BackupEntry[], purpose: BackupPurpose = 'cutover', platform: NodeJS.Platform = process.platform): string {
  const windows = platform === 'win32';
  const reversed = [...entries].reverse();
  const lines = reversed.filter((e) => !('task' in e) && !('recovery' in e)).map((e) => {
    if (windows) {
      if ('backup' in e) return `Copy-Item -LiteralPath ${psQuote(e.backup)} -Destination ${psQuote(e.original)} -Force`;
      if ('link' in e) return `New-Item -ItemType SymbolicLink -Path ${psQuote(e.original)} -Target ${psQuote(e.link)} -Force`;
      return `Remove-Item -LiteralPath ${psQuote(e.original)} -Force -ErrorAction SilentlyContinue`;
    }
    if ('backup' in e) return `cp -p ${quote(e.backup)} ${quote(e.original)}`;
    if ('link' in e) return `ln -sfn ${quote(e.link)} ${quote(e.original)}`;
    return `rm -f ${quote(e.original)}`;
  });
  const recovery = purpose === 'cutover' ? executableRecoveryRecipe(entries, platform) : [];
  if (windows) {
    const tasks = reversed.flatMap((e) => 'task' in e && e.task !== undefined
      ? [`Register-ScheduledTask -TaskName ${psQuote(e.task)} -Xml (Get-Content -LiteralPath ${psQuote(e.backup)} -Raw -Encoding UTF8) -Force`]
      : []);
    return [
      purpose === 'provision' ? '# Undo a Myco agent setup' : '# Undo a Myco cutover', '',
      'Stop anything using Myco 2.0 on this machine, then run in PowerShell:', '',
      ...executableBlock(lines, windows), '', ...recovery,
      ...(tasks.length > 0 ? [...executableBlock(tasks, windows), ''] : []),
      ...(tasks.length > 0 ? ['Task definitions retain their saved enable state. Start the restored task when ready.'] : []),
      ...(purpose === 'cutover' ? ['The 1.4 vaults were never changed; the Deployment keeps what was imported.'] : []), '',
    ].join('\n');
  }
  if (purpose === 'provision') {
    return ['# Undo a Myco agent setup', '', 'Run, from any directory:', '', ...executableBlock(lines, windows), ''].join('\n');
  }
  return [
    '# Undo a Myco cutover',
    '',
    'Stop anything using Myco 2.0 on this machine, then run, from any directory:',
    '',
    ...executableBlock(lines, windows),
    '',
    ...recovery,
    'Then start the Myco 1.4 service again from its restored unit file, for example',
    '`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/co.goondocks.myco.plist` on macOS.',
    'The 1.4 vaults were never changed; the Deployment keeps what was imported.',
    '',
  ].join('\n');
}

export class CutoverBackup {
  private readonly entries: BackupEntry[] = [];

  constructor(readonly dir: string, private readonly purpose: BackupPurpose = 'cutover', private readonly platform: NodeJS.Platform = process.platform) {}

  /** The copy's path: the original's absolute path, mirrored under the folder. */
  pathFor(original: string): string {
    return path.join(this.dir, path.resolve(original).replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''));
  }

  /** Copy `original`, keeping its mode, and record it. */
  take(original: string): BackupEntry {
    const backup = this.pathFor(original);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.copyFileSync(original, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, fs.statSync(original).mode & 0o7777);
    return this.record({ original, backup, sha256: sha256(fs.readFileSync(backup)) });
  }

  /** Keep a service unit and the executable its undo needs. */
  takeLegacyUnit(unit: MycoUnit, recovery: LegacyExecutableRecovery): void {
    this.take(unit.file);
    if (this.entries.some(entry => 'recovery' in entry && entry.original === unit.executable)) return;
    if (recovery.kind === 'saved') {
      const source = path.join(this.dir, 'legacy-executables', recovery.sha256, path.basename(unit.executable));
      try {
        fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
        fs.copyFileSync(recovery.source, source);
        fs.chmodSync(source, fs.statSync(recovery.source).mode & 0o7777);
        if (sha256(fs.readFileSync(source)) !== recovery.sha256) throw new Error('The executable changed while it was being saved.');
        recovery = { ...recovery, source };
      } catch (error) {
        recovery = { kind: 'missing', candidates: [], version: recovery.version,
          warnings: [...recovery.warnings, `Could not save the executable for undo: ${(error as Error).message}`] };
      }
    }
    this.record({ original: unit.executable, recovery });
  }

  /** Keep a Task Scheduler definition before disabling or unregistering it. */
  scheduledTask(label: string, xml: string, previouslyDisabled = false): BackupEntry {
    if (previouslyDisabled && fs.existsSync(path.dirname(this.dir))) {
      const root = path.dirname(this.dir);
      const folders = fs.readdirSync(root).filter(folder => folder.startsWith(FOLDER_PREFIX) && path.join(root, folder) !== this.dir).sort().reverse();
      for (const folder of folders) {
        const entry = readManifest(path.join(root, folder)).find(entry => 'task' in entry && entry.task === label);
        if (entry !== undefined && 'backup' in entry && fs.existsSync(entry.backup)
          && sha256(fs.readFileSync(entry.backup)) === entry.sha256) return this.record(entry);
      }
    }
    const backup = path.join(this.dir, 'windows-tasks', `${crypto.createHash('sha256').update(label).digest('hex')}.xml`);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(backup, xml);
    return this.record({ original: `schtasks:${label}`, backup, sha256: sha256(Buffer.from(xml)), task: label });
  }

  /** Record a file the cutover creates, so undoing it removes the file. */
  created(original: string): BackupEntry {
    return this.record({ original, created: true });
  }

  /** Record a link the cutover removes or repoints, with where it pointed. */
  link(original: string, target: string): BackupEntry {
    return this.record({ original, link: target });
  }

  /** Drop the copies of files still holding the bytes they were copied with; answer the entries kept. */
  pruneUnchanged(): BackupEntry[] {
    const kept = this.entries.filter((entry) => {
      if (!('sha256' in entry) || 'task' in entry) return true;
      let current: string | null = null;
      try { current = sha256(fs.readFileSync(entry.original)); } catch { /* a removed original keeps its copy */ }
      if (current !== entry.sha256) return true;
      fs.rmSync(entry.backup, { force: true });
      return false;
    });
    this.entries.splice(0, this.entries.length, ...kept);
    if (kept.length === 0) fs.rmSync(this.dir, { recursive: true, force: true });
    else this.write();
    return kept;
  }

  get all(): readonly BackupEntry[] {
    return this.entries;
  }

  private record(entry: BackupEntry): BackupEntry {
    this.entries.push(entry);
    this.write();
    return entry;
  }

  private write(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(path.join(this.dir, MANIFEST_FILE), `${JSON.stringify({ entries: this.entries }, null, 2)}\n`);
    writePrivateFileAtomic(path.join(this.dir, RESTORE_FILE), restoreRecipe(this.entries, this.purpose, this.platform));
  }
}
