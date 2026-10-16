/** File evidence for the executable a restored 1.x service needs. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { valid } from 'semver';
import type { LegacyExecutableRecovery } from '@myco/member/cutover-backup.js';
import type { MycoUnit } from '@myco/member/legacy-unit-files.js';

export const LEGACY_EXECUTABLE_RECORD = 'legacy-executable.json';

const legacyVersion = (value: unknown): string | null =>
  typeof value === 'string' && valid(value) && value.startsWith('1.') ? value : null;

export function identifyLegacyExecutable(unit: Pick<MycoUnit, 'executable' | 'home'>): LegacyExecutableRecovery {
  const warnings: string[] = [];
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
  let version: string | null = null;
  if (record?.replaced_at === unit.executable) {
    version = legacyVersion(record.version);
    if (typeof record.path === 'string' && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sha256)) {
      const relative = path.relative(bin, record.path);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        try {
          const digest = crypto.createHash('sha256').update(fs.readFileSync(record.path)).digest('hex');
          if (digest === record.sha256.toLowerCase()) return { kind: 'saved', source: record.path, sha256: digest, version, warnings };
          warnings.push(`The saved executable at ${record.path} does not match its recorded checksum.`);
        } catch (error) { warnings.push(`Could not read the saved executable at ${record.path}: ${(error as Error).message}`); }
      }
    }
  }
  const daemon = unit.home ? read(path.join(unit.home, 'service', 'daemon.json')) : null;
  const daemonVersion = legacyVersion(daemon?.version);
  version ??= daemonVersion;
  const versions = path.join(bin, 'versions');
  let names: string[] = [];
  try { names = fs.readdirSync(versions); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not list saved executables at ${versions}: ${(error as Error).message}`);
  }
  const candidates = names.filter(name => legacyVersion(name) !== null).sort().flatMap(name => {
    const file = path.join(versions, name, path.basename(unit.executable));
    try { return fs.statSync(file).isFile() ? [file] : []; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not inspect ${file}: ${(error as Error).message}`);
      return [];
    }
  });
  const preservedCandidates: string[] = [];
  const preserved = path.join(bin, 'legacy');
  try {
    for (const hash of fs.readdirSync(preserved).filter(name => /^[a-f0-9]{64}$/i.test(name))) {
      const file = path.join(preserved, hash, path.basename(unit.executable));
      try {
        if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === hash.toLowerCase()) preservedCandidates.push(file);
        else warnings.push(`The saved executable at ${file} does not match its directory checksum.`);
      } catch (error) { warnings.push(`Could not inspect ${file}: ${(error as Error).message}`); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not list preserved executables at ${preserved}: ${(error as Error).message}`);
  }
  const daemonSlot = candidates.find(file => path.basename(path.dirname(file)) === daemonVersion);
  const selected = daemonSlot
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (selected) {
    try {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(selected)).digest('hex');
      return { kind: 'saved', source: selected, sha256: digest,
        version: path.basename(path.dirname(selected)), warnings };
    } catch (error) { warnings.push(`Could not read ${selected}: ${(error as Error).message}`); }
  }
  return { kind: 'missing', candidates: [...candidates, ...preservedCandidates], version, warnings };
}
