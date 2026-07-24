/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import fs from 'node:fs';
import path from 'node:path';

function normalizeMissingSegment(segment: string): string {
  const normalized = segment.normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

interface ResolvedPathIdentity {
  canonicalPath: string;
  existing: fs.BigIntStats | undefined;
  ancestor: fs.BigIntStats;
  missing: string[];
}

function resolvePathIdentity(target: string): ResolvedPathIdentity {
  let current = path.resolve(target);
  const missing: string[] = [];

  while (true) {
    try {
      const stat = fs.statSync(current, { bigint: true });
      const canonicalAncestor = fs.realpathSync(current);
      return {
        canonicalPath: path.join(canonicalAncestor, ...missing),
        existing: missing.length === 0 ? stat : undefined,
        ancestor: stat,
        missing,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function samePhysicalObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function alternateCaseBasename(basename: string): string | undefined {
  const characters = [...basename];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    if (lower === upper) continue;
    characters[index] = character === lower ? upper : lower;
    return characters.join('');
  }
  return undefined;
}

function* alternateCasePaths(target: string): Generator<string> {
  const root = path.parse(target).root;
  let current = target;
  const suffix: string[] = [];
  while (current !== root) {
    const basename = path.basename(current);
    const alternate = alternateCaseBasename(basename);
    if (alternate !== undefined) {
      yield path.join(path.dirname(current), alternate, ...suffix);
    }
    suffix.unshift(basename);
    current = path.dirname(current);
  }
}

function hasCaseAlias(identity: ResolvedPathIdentity): boolean {
  if (identity.existing === undefined
    || (process.platform !== 'darwin' && process.platform !== 'win32')) return false;
  for (const alternate of alternateCasePaths(identity.canonicalPath)) {
    try {
      if (samePhysicalObject(identity.existing, fs.statSync(alternate, { bigint: true }))) {
        return true;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
  }
  return false;
}

/**
 * Identity for the physical object at `target`, following directory links.
 * Missing suffixes are anchored to the nearest existing physical ancestor.
 */
export function physicalPathIdentity(target: string): string {
  const identity = resolvePathIdentity(target);
  const physical = `${identity.ancestor.dev}:${identity.ancestor.ino}`;
  if (identity.existing !== undefined) return `inode:${physical}`;
  return `ancestor:${physical}:missing:${JSON.stringify(identity.missing.map(normalizeMissingSegment))}`;
}

/**
 * Lock identities spanning lexical, case-alias transition, and physical
 * representations of one path.
 */
export function physicalPathLockIdentities(target: string): string[] {
  const identity = resolvePathIdentity(target);
  const canonical = identity.canonicalPath.normalize('NFC');
  const identities = [`path:${canonical}`];
  if (identity.existing === undefined || hasCaseAlias(identity)) {
    identities.push(`casefold:${canonical.toLowerCase()}`);
  }
  if (identity.existing !== undefined) {
    identities.push(`inode:${identity.existing.dev}:${identity.existing.ino}`);
  }
  return [...new Set(identities)].sort();
}
