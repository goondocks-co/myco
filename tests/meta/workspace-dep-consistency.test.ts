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
/**
 * A dependency declared in MORE THAN ONE workspace manifest must resolve
 * to ONE version.
 *
 * The failure class this pins (gotcha-6b06370d): both the monorepo root
 * and `packages/myco` declared `@openai/agents`; a bump touched only the
 * root, and since `^0.13.5` cannot admit 0.14.x, npm installed BOTH —
 * two `@openai/agents-core` copies with split module identity. A
 * `Runner.prototype.run` patch applied through one copy never intercepts
 * the other copy's runner, which presented as "the SDK restructured its
 * config surface" (it hadn't). The split is silent: installs succeed,
 * typechecks pass, and the stale copy runs old code at runtime.
 *
 * The guard is on the DECLARED ranges, not the install tree: twin
 * declarations whose ranges do not intersect go red in the same diff as
 * the half-applied bump, before any install-state analysis is needed.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface ManifestDecl {
  manifest: string;
  range: string;
}

function readManifest(rel: string): Record<string, unknown> | null {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return JSON.parse(fs.readFileSync(abs, 'utf-8')) as Record<string, unknown>;
}

/** Root + every workspace manifest, plus the nested ui/worker package roots
 *  that hold their own lockfiles (installed separately, same split risk). */
function manifestPaths(): string[] {
  const root = readManifest('package.json')!;
  const workspaces = (root.workspaces as string[] | undefined) ?? [];
  const paths = new Set<string>(['package.json']);
  for (const pattern of workspaces) {
    // Simple star-glob expansion (the repo uses `packages/*`-style patterns).
    if (pattern.includes('*')) {
      const base = pattern.slice(0, pattern.indexOf('*')).replace(/\/$/, '');
      const dir = path.join(REPO_ROOT, base);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) paths.add(path.posix.join(base, entry.name, 'package.json'));
      }
    } else {
      paths.add(path.posix.join(pattern, 'package.json'));
    }
  }
  // Nested roots with their own lockfiles (not npm workspaces).
  for (const nested of [
    'packages/myco/ui/package.json',
    'packages/myco-team/worker/package.json',
    'packages/myco-server/package.json',
    'packages/myco-server/ui/package.json',
  ]) {
    paths.add(nested);
  }
  return [...paths].filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
}

describe('workspace dependency consistency', () => {
  test('every dependency declared in multiple manifests has intersecting ranges', () => {
    const declarations = new Map<string, ManifestDecl[]>();
    for (const rel of manifestPaths()) {
      const manifest = readManifest(rel);
      if (!manifest) continue;
      for (const section of ['dependencies', 'devDependencies'] as const) {
        const deps = (manifest[section] as Record<string, string> | undefined) ?? {};
        for (const [pkg, range] of Object.entries(deps)) {
          // Non-registry specifiers (workspace links, file:, git) have no
          // semver range to compare.
          if (!semver.validRange(range)) continue;
          const list = declarations.get(pkg) ?? [];
          list.push({ manifest: rel, range });
          declarations.set(pkg, list);
        }
      }
    }

    const conflicts: string[] = [];
    for (const [pkg, decls] of declarations) {
      if (decls.length < 2) continue;
      for (let i = 0; i < decls.length; i++) {
        for (let j = i + 1; j < decls.length; j++) {
          if (!semver.intersects(decls[i]!.range, decls[j]!.range)) {
            conflicts.push(
              `${pkg}: ${decls[i]!.manifest} declares "${decls[i]!.range}" but ${decls[j]!.manifest} declares "${decls[j]!.range}"`,
            );
          }
        }
      }
    }

    expect(
      conflicts,
      'Twin dependency declarations with non-intersecting ranges — npm will install BOTH versions and '
      + 'silently split module identity (see gotcha-6b06370d / the @openai/agents 0.13-vs-0.14 incident). '
      + 'Bump every manifest that declares the package, in the same commit:\n\n' + conflicts.join('\n'),
    ).toEqual([]);
  });
});
