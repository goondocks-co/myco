/** File evidence for the executable a restored 1.x service needs. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { valid } from 'semver';
import type { LegacyExecutableRecovery } from '@myco/member/cutover-backup.js';
import type { MycoUnit } from '@myco/member/legacy-unit-files.js';

export const LEGACY_EXECUTABLE_RECORD = 'legacy-executable.json';

const versionInMajor = (value: unknown, major: number): string | null =>
  typeof value === 'string' && valid(value) && value.startsWith(`${major}.`) ? value : null;
const legacyVersion = (value: unknown): string | null => versionInMajor(value, 1);

export function identifyLegacyExecutable(unit: Pick<MycoUnit, 'executable' | 'home'>, platform: NodeJS.Platform = process.platform): LegacyExecutableRecovery {
  const warnings: string[] = [];
  const identity = (file: string): string => platform === 'win32' ? path.win32.resolve(file).toLowerCase() : path.resolve(file);
  const hash = (file: string): string | null => {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read ${file}: ${(error as Error).message}`);
      return null;
    }
  };
  const currentHash = hash(unit.executable);
  const read = (file: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read ${file}: ${(error as Error).message}`);
      return null;
    }
  };
  const executableDir = path.dirname(unit.executable);
  const bin = path.basename(path.dirname(executableDir)) === 'versions' ? path.dirname(path.dirname(executableDir)) : executableDir;
  const record = unit.home ? read(path.join(unit.home, LEGACY_EXECUTABLE_RECORD)) : null;
  const matchesRecord = typeof record?.replaced_at === 'string' && identity(record.replaced_at) === identity(unit.executable);
  const recordedVersion = matchesRecord ? legacyVersion(record.version) : null;
  const recordedHash = matchesRecord && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sha256) ? record.sha256.toLowerCase() : null;
  type Candidate = { source: string; sha256: string; version: string | null };
  let recordedCopy: Candidate | null = null;
  const rejected = new Set<string>();
  if (recordedHash && typeof record?.path === 'string') {
    const relative = path.relative(bin, record.path);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      const digest = hash(record.path);
      if (digest === recordedHash) recordedCopy = { source: record.path, sha256: digest, version: recordedVersion };
      else {
        rejected.add(identity(record.path));
        warnings.push(`The saved executable at ${record.path} does not match its recorded checksum.`);
      }
    }
  }
  if (currentHash && currentHash === recordedHash) return { kind: 'present', version: recordedVersion, warnings };
  const marker = unit.home ? read(path.join(unit.home, 'install.json')) : null;
  const installedVersion = legacyVersion(marker?.version);
  const markerMatchesCurrent = Boolean(currentHash && typeof marker?.bin === 'string' && identity(marker.bin) === identity(unit.executable)
    && typeof marker.binary_sha256 === 'string' && marker.binary_sha256.toLowerCase() === currentHash);
  if (installedVersion && markerMatchesCurrent) {
    return { kind: 'present', version: installedVersion, warnings };
  }
  const list = (dir: string): string[] => {
    try { return fs.readdirSync(dir).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not list saved executables at ${dir}: ${(error as Error).message}`);
      return [];
    }
  };
  const versionNames = list(path.join(bin, 'versions'));
  const currentIs2 = Boolean(currentHash && (markerMatchesCurrent && versionInMajor(marker?.version, 2)
    || versionNames.filter(name => versionInMajor(name, 2)).some(name => hash(path.join(bin, 'versions', name, path.basename(unit.executable))) === currentHash)));
  const candidates: Candidate[] = [];
  for (const name of versionNames.filter(name => legacyVersion(name) !== null)) {
    const source = path.join(bin, 'versions', name, path.basename(unit.executable));
    if (rejected.has(identity(source))) continue;
    const digest = hash(source);
    if (digest) candidates.push({ source, sha256: digest, version: name });
  }
  const currentSlot = candidates.find(candidate => candidate.sha256 === currentHash);
  if (currentSlot) return { kind: 'present', version: currentSlot.version, warnings };
  for (const name of list(path.join(bin, 'legacy')).filter(name => /^[a-f0-9]{64}$/i.test(name))) {
    const source = path.join(bin, 'legacy', name, path.basename(unit.executable));
    if (rejected.has(identity(source))) continue;
    const digest = hash(source);
    if (digest === name.toLowerCase()) candidates.push({ source, sha256: digest, version: null });
    else if (digest) warnings.push(`The saved executable at ${source} does not match its directory checksum.`);
  }
  const daemonVersion = unit.home ? legacyVersion(read(path.join(unit.home, 'service', 'daemon.json'))?.version) : null;
  const version = recordedVersion ?? daemonVersion;
  const missing = (choices: Candidate[] = []): LegacyExecutableRecovery => ({ kind: 'missing', candidates: choices.map(candidate => candidate.source), version, warnings, currentIs2 });
  if (recordedHash) {
    const selected = recordedCopy ?? candidates.find(candidate => candidate.sha256 === recordedHash);
    return selected ? { kind: 'saved', ...selected, version: recordedVersion ?? selected.version, warnings, currentIs2 } : missing();
  }
  if (version) {
    if (recordedVersion && daemonVersion && recordedVersion !== daemonVersion) return missing();
    const selected = candidates.find(candidate => candidate.version === version);
    return selected ? { kind: 'saved', ...selected, warnings, currentIs2 } : missing();
  }
  const selected = candidates.length === 1 && candidates[0].version ? candidates[0] : null;
  return selected ? { kind: 'saved', ...selected, warnings, currentIs2 } : missing(candidates);
}
