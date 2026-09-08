/**
 * Meta gate: the skill locations `docs/symbionts.md` publishes are locations the
 * installer actually writes.
 *
 * Where a symbiont keeps its skills is manifest data, and the manifests moved
 * seven agents onto the shared `~/.agents/skills` while the document kept the
 * per-agent paths those agents used before. Six of nine rows named a target the
 * installer now lists under `retiredGlobalSkillsTargets` and actively sweeps, so
 * a reader who followed one found nothing, or found a link about to be removed.
 *
 * Documenting a retired location is worse than documenting none: it reads as a
 * fact, and it fails silently for the person following it rather than for anyone
 * who could fix it.
 *
 * The gate is deliberately not a section-to-manifest mapping. The document's own
 * headings are a third naming of these agents — one section is titled for a
 * product rename the manifests do not carry — so keying on the heading would
 * encode a correspondence that is already untrue. It asserts the weaker property
 * that actually catches the defect: every skills path the document names is some
 * manifest's live target, and no path is a retired one.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFESTS = path.join(REPO_ROOT, 'packages/myco/src/symbionts/manifests');
const DOC = path.join(REPO_ROOT, 'docs/symbionts.md');

/** One scalar field from a manifest, read without a YAML dependency. */
const field = (yaml: string, key: string): string | null =>
  new RegExp(`^\\s*${key}:\\s*(\\S.*)$`, 'm').exec(yaml)?.[1].trim() ?? null;

/** A `retired…Targets:` list's items. */
function listItems(yaml: string, key: string): string[] {
  const start = new RegExp(`^\\s*${key}:\\s*$`, 'm').exec(yaml);
  if (start === null) return [];
  const rest = yaml.slice(start.index + start[0].length).split('\n').slice(1);
  const items: string[] = [];
  for (const line of rest) {
    const item = /^\s+-\s+(\S.*)$/.exec(line);
    if (item === null) break;
    items.push(item[1].trim());
  }
  return items;
}

/** Trailing slashes and backticks off, so `~/.agents/skills/` and `~/.agents/skills` compare equal. */
const normalize = (p: string): string => p.replace(/^`|`$/g, '').replace(/\/+$/, '');

function manifestTargets(): { live: Set<string>; retired: Set<string> } {
  const live = new Set<string>();
  const retired = new Set<string>();
  for (const file of fs.readdirSync(MANIFESTS).filter((f) => f.endsWith('.yaml'))) {
    const yaml = fs.readFileSync(path.join(MANIFESTS, file), 'utf-8');
    const target = field(yaml, 'globalSkillsTarget');
    if (target !== null && target !== 'null') live.add(normalize(target));
    for (const item of listItems(yaml, 'retiredGlobalSkillsTargets')) retired.add(normalize(item));
  }
  return { live, retired };
}

/** Every `| Skills | \`path\` …|` row the document publishes. */
function documentedPaths(): string[] {
  return [...fs.readFileSync(DOC, 'utf-8').matchAll(/^\|\s*Skills\s*\|\s*`([^`]+)`/gm)].map((m) => normalize(m[1]));
}

describe('documented skill locations', () => {
  const { live, retired } = manifestTargets();
  const documented = documentedPaths();

  it('reads a non-empty document and a non-empty set of manifest targets', () => {
    // Both sides feed the cases below; either being empty would pass them all.
    expect(documented.length).toBeGreaterThan(0);
    expect(live.size).toBeGreaterThan(0);
    expect(retired.size).toBeGreaterThan(0);
  });

  it('names only locations some manifest currently writes', () => {
    expect([...new Set(documented)].filter((p) => !live.has(p)).sort()).toEqual([]);
  });

  it('names no location the installer sweeps', () => {
    // A retired target that is not also some other agent's live one. The two
    // sets overlap by design — one agent's retired path can be another's
    // current one — so only the difference is a defect.
    const swept = [...retired].filter((p) => !live.has(p));
    expect([...new Set(documented)].filter((p) => swept.includes(p)).sort()).toEqual([]);
  });
});
