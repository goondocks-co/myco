/**
 * Every document the installers and the install docs link to exists.
 *
 * The installer's refusal, the release notes, the README and the quickstart
 * send a person to guides such as the self-hosting guide and "Upgrading from
 * 1.4". A link to a page that is not in the repository is a dead end at the
 * moment someone needs it, so each linked Markdown path must be a file here.
 *
 * `PENDING` names a guide another PR adds, with the PR: this one merges after
 * it. Once the guide is on the branch the entry fails, so it is removed rather
 * than left to excuse a later dead link.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dir, '..', '..');

/** The files a person installing Myco reads links from. */
const SURFACES = ['docs/install.sh', 'docs/install.ps1', 'README.md', 'docs/quickstart.md', 'docs/team-host.md', '.github/workflows/publish.yml'];

/** Guides another PR adds, each with that PR. This PR (#1495) merges after it. */
const PENDING: Readonly<Record<string, string>> = {};

/** Every repository Markdown path a surface links to, as a path from the repository root. */
function linkedDocs(surface: string): string[] {
  const text = fs.readFileSync(path.join(REPO, surface), 'utf8');
  const found = new Set<string>();
  // An absolute link into this repository's main branch.
  for (const m of text.matchAll(/github\.com\/(?:goondocks-co\/myco|\$\{REPO\}|\$Repo)\/blob\/main\/([A-Za-z0-9_./-]+\.md)/g)) found.add(m[1]!);
  // In the installer, the repository is a variable.
  for (const m of text.matchAll(/\$\{REPO\}\/blob\/main\/([A-Za-z0-9_./-]+\.md)/g)) found.add(m[1]!);
  // A relative Markdown link, from the surface's own folder.
  if (surface.endsWith('.md')) {
    for (const m of text.matchAll(/\]\((?!https?:)(\.\/)?([A-Za-z0-9_./-]+\.md)(#[^)]*)?\)/g)) found.add(path.normalize(path.join(path.dirname(surface), m[2]!)));
  }
  return [...found].sort();
}

describe('the documents the installers link to', () => {
  it('finds the links it checks (guards against a scan that matches nothing)', () => {
    expect(linkedDocs('docs/install.sh')).toEqual(['docs/self-hosting.md', 'docs/upgrade.md']);
    expect(linkedDocs('README.md').length).toBeGreaterThan(5);
  });

  it('are all in the repository, but for a guide another PR adds', () => {
    const missing: string[] = [];
    for (const surface of SURFACES) {
      for (const doc of linkedDocs(surface)) {
        if (!fs.existsSync(path.join(REPO, doc)) && PENDING[doc] === undefined) missing.push(`${surface} → ${doc}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names no pending guide that has landed, so the exception does not outlive its reason', () => {
    expect(Object.keys(PENDING).filter((doc) => fs.existsSync(path.join(REPO, doc)))).toEqual([]);
  });
});
