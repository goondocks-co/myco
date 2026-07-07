import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectVault } from '@myco/vault/project-vault.js';
import {
  MAX_PLANNED_PAGES,
  readPlan,
  validateWikiPlan,
  writePlan,
  type WikiPagePlan,
  type WikiPlan,
} from '@myco/okf/synthesis/plan.js';

let projectRoot: string;
let vault: ProjectVault;

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-plan-')));
  vault = new ProjectVault(projectRoot);
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function page(over: Partial<WikiPagePlan> = {}): WikiPagePlan {
  return {
    path: 'concepts/overview',
    type: 'concept',
    title: 'Overview',
    rationale: 'Synthesizes the entry points.',
    sourceRefs: ['spore-1'],
    ...over,
  };
}

function plan(over: Partial<WikiPlan> = {}): WikiPlan {
  return {
    generatedAt: '2026-07-06T12:00:00Z',
    sinceRef: 'abc123',
    pages: [page()],
    ...over,
  };
}

describe('validateWikiPlan', () => {
  it('accepts a focused plan carrying openQuestions', () => {
    const p = plan({
      pages: [
        page({ path: 'concepts/overview', openQuestions: ['Is the daemon single-writer?'] }),
        page({ path: 'architecture/data-flow', type: 'overview' }),
      ],
    });
    expect(validateWikiPlan(p)).toEqual([]);
  });

  it('rejects duplicate paths, naming the offending path', () => {
    const errors = validateWikiPlan(plan({ pages: [page({ path: 'a/b' }), page({ path: 'a/b' })] }));
    expect(errors.some((e) => e.includes('duplicate') && e.includes('a/b'))).toBe(true);
  });

  it('rejects an absolute path (not OKF-slug-safe)', () => {
    const errors = validateWikiPlan(plan({ pages: [page({ path: '/etc/passwd' })] }));
    expect(errors.some((e) => e.includes('/etc/passwd'))).toBe(true);
  });

  it('rejects a traversal path (not OKF-slug-safe)', () => {
    const errors = validateWikiPlan(plan({ pages: [page({ path: '../escape' })] }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty type', () => {
    const errors = validateWikiPlan(plan({ pages: [page({ type: '' })] }));
    expect(errors.some((e) => e.includes('empty type'))).toBe(true);
  });

  it('rejects a plan over the MAX_PLANNED_PAGES cap (31 pages)', () => {
    const pages = Array.from({ length: MAX_PLANNED_PAGES + 1 }, (_, i) => page({ path: `concepts/p-${i}` }));
    const errors = validateWikiPlan(plan({ pages }));
    expect(errors.some((e) => e.includes(String(MAX_PLANNED_PAGES)))).toBe(true);
  });

  it('accepts exactly MAX_PLANNED_PAGES pages (boundary)', () => {
    const pages = Array.from({ length: MAX_PLANNED_PAGES }, (_, i) => page({ path: `concepts/p-${i}` }));
    expect(validateWikiPlan(plan({ pages }))).toEqual([]);
  });

  it('collects ALL violations rather than early-returning on the first', () => {
    const p = plan({
      pages: [
        page({ path: '/absolute', type: '' }), // both slug-unsafe AND empty type
        page({ path: 'dup' }),
        page({ path: 'dup' }), // duplicate
      ],
    });
    const errors = validateWikiPlan(p);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((e) => e.includes('/absolute'))).toBe(true);
    expect(errors.some((e) => e.includes('empty type'))).toBe(true);
    expect(errors.some((e) => e.includes('duplicate') && e.includes('dup'))).toBe(true);
  });
});

describe('writePlan / readPlan', () => {
  it('round-trips a full plan through .myco/okf/state/plan.json', () => {
    const p = plan({
      pages: [
        page({ path: 'concepts/overview', openQuestions: ['open?'] }),
        page({ path: 'architecture/data-flow', type: 'overview', sourceRefs: ['canopy-1', 'spore-2'] }),
      ],
    });
    writePlan(vault, p);
    expect(readPlan(vault)).toEqual(p);

    // Persisted alongside the OKF manifest, with the gitignore-first discipline.
    const planFile = path.join(projectRoot, '.myco/okf/state/plan.json');
    expect(fs.existsSync(planFile)).toBe(true);
    expect(vault.okfPlanPath()).toBe(planFile);
    const gitignore = fs.readFileSync(path.join(projectRoot, '.myco/.gitignore'), 'utf-8');
    expect(gitignore).toContain('okf/');
  });

  it('returns null when no plan has been written, creating nothing', () => {
    expect(readPlan(vault)).toBeNull();
    expect(fs.existsSync(path.join(projectRoot, '.myco/okf'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.myco/.gitignore'))).toBe(false);
  });

  it('returns null on a corrupt or shape-invalid plan file without throwing', () => {
    vault.okfStateDir();
    fs.writeFileSync(vault.okfPlanPath(), '{ not json');
    expect(readPlan(vault)).toBeNull();
    // Parses as JSON but violates the WikiPlan shape (generatedAt must be a string).
    fs.writeFileSync(vault.okfPlanPath(), JSON.stringify({ generatedAt: 5, sinceRef: 'x', pages: [] }));
    expect(readPlan(vault)).toBeNull();
  });
});
