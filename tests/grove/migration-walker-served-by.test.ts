/**
 * Migration-walker Grove-ownership boundary.
 *
 * Catastrophic regression caught in dogfood (spore `bug_fix-5b1f1b1d`):
 * the walker walked `listGroves(mycoHome)` unfiltered, so a dev daemon's
 * walker pass mutated working trees in prod-served projects. Across 5
 * prod-served projects on the developer machine the walker deleted Myco
 * config files (.agents/myco-*.cjs, .claude/settings.json,
 * .codex/{config.toml,hooks.json}, .cursor/*, .mcp.json, opencode.json,
 * .opencode/plugins/myco.ts) and stripped Myco-managed blocks from
 * .gitignore, CLAUDE.md, .myco/myco.yaml.
 *
 * This suite locks the boundary: walker invoked for one daemon variant
 * must visit only that variant's Groves and leave files in cross-variant
 * projects byte-identical.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runProjectLocalMigration,
} from '@myco/grove/migration-walker.js';
import {
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

interface SeededProject {
  projectRoot: string;
  /** Snapshot of every file under `projectRoot` taken right after seed. */
  snapshot: Map<string, string>;
}

let tmpMycoHome: string;
let tmpProjectsParent: string;

beforeEach(() => {
  // Two separate tmpdirs: one for the fake `~/.myco/` Grove registry,
  // one for the fake project trees we register into the Groves.
  // Keeping them separate makes the assertion shape obvious: we never
  // want the walker to reach projects whose roots live entirely
  // outside the registry it was supposed to walk.
  tmpMycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-walker-served-by-home-'));
  tmpProjectsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-walker-served-by-projects-'));
  fs.mkdirSync(path.join(tmpMycoHome, 'groves'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpMycoHome, { recursive: true, force: true });
  fs.rmSync(tmpProjectsParent, { recursive: true, force: true });
});

function seedProject(name: string): SeededProject {
  const projectRoot = path.join(tmpProjectsParent, name);
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
  // Plant exactly the files the walker is known to delete or rewrite.
  // Each carries content unique enough to detect any modification.
  fs.writeFileSync(path.join(projectRoot, '.agents', 'myco-run.cjs'), `myco-run for ${name}`);
  fs.writeFileSync(path.join(projectRoot, '.agents', 'myco-cli.cjs'), `myco-cli for ${name}`);
  fs.writeFileSync(path.join(projectRoot, '.myco', 'runtime.command'), '/some/binary\n');
  fs.writeFileSync(path.join(projectRoot, '.myco', 'myco.yaml'), `# ${name}\nversion: 3\n`);
  // Snapshot at seed time — every file must match this after the walker.
  return { projectRoot, snapshot: walkTree(projectRoot) };
}

function walkTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(root)) return out;
  const recurse = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile()) {
        try {
          out.set(full, fs.readFileSync(full, 'utf-8'));
        } catch { /* unreadable; skip */ }
      }
    }
  };
  recurse(root);
  return out;
}

describe('migration walker — Grove ownership boundary', () => {
  it('dev daemon walker mutates only dev-served Groves; prod-served projects stay byte-identical', () => {
    // Seed two Groves on the same fake mycoHome:
    //   - devGrove (served_by: service-dev) with one registered project
    //   - prodGrove (served_by: service) with one registered project
    const devGrove = createGrove('devspace', tmpMycoHome, { servedBy: 'service-dev' });
    const prodGrove = createGrove('prodspace', tmpMycoHome, { servedBy: 'service' });

    const devProject = seedProject('dev-project');
    const prodProject = seedProject('prod-project');

    registerProjectInGrove(devGrove.id, {
      projectId: 'proj_dev_test',
      projectName: 'dev-project',
      projectRoot: devProject.projectRoot,
    }, tmpMycoHome);
    registerProjectInGrove(prodGrove.id, {
      projectId: 'proj_prod_test',
      projectName: 'prod-project',
      projectRoot: prodProject.projectRoot,
    }, tmpMycoHome);

    // Snapshot the prod project's tree right before the dev walker runs.
    // After the walker we expect this to be byte-identical.
    const prodBefore = walkTree(prodProject.projectRoot);

    // Run walker as the DEV daemon would.
    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service-dev');

    // Walker visited only the dev grove's project (one project, not two).
    expect(result.projectsVisited).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].project.root).toBe(devProject.projectRoot);
    expect(result.outcomes[0].groveId).toBe(devGrove.id);

    // Prod project is BYTE-IDENTICAL to its pre-walker state.
    const prodAfter = walkTree(prodProject.projectRoot);
    const prodBeforeKeys = [...prodBefore.keys()].sort();
    const prodAfterKeys = [...prodAfter.keys()].sort();
    expect(prodAfterKeys).toEqual(prodBeforeKeys);
    for (const key of prodBeforeKeys) {
      expect(prodAfter.get(key)).toBe(prodBefore.get(key)!);
    }
  });

  it('prod daemon walker mutates only prod-served Groves; dev-served projects stay byte-identical', () => {
    // Symmetric assertion: prod variant must not reach into dev Grove
    // projects either. The boundary is bidirectional.
    const devGrove = createGrove('devspace', tmpMycoHome, { servedBy: 'service-dev' });
    const prodGrove = createGrove('prodspace', tmpMycoHome, { servedBy: 'service' });

    const devProject = seedProject('dev-project');
    const prodProject = seedProject('prod-project');

    registerProjectInGrove(devGrove.id, {
      projectId: 'proj_dev_test',
      projectName: 'dev-project',
      projectRoot: devProject.projectRoot,
    }, tmpMycoHome);
    registerProjectInGrove(prodGrove.id, {
      projectId: 'proj_prod_test',
      projectName: 'prod-project',
      projectRoot: prodProject.projectRoot,
    }, tmpMycoHome);

    const devBefore = walkTree(devProject.projectRoot);

    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service');

    expect(result.projectsVisited).toBe(1);
    expect(result.outcomes[0].groveId).toBe(prodGrove.id);

    const devAfter = walkTree(devProject.projectRoot);
    const devBeforeKeys = [...devBefore.keys()].sort();
    const devAfterKeys = [...devAfter.keys()].sort();
    expect(devAfterKeys).toEqual(devBeforeKeys);
    for (const key of devBeforeKeys) {
      expect(devAfter.get(key)).toBe(devBefore.get(key)!);
    }
  });

  it('passes audit-log totals reflecting only the served-by-scoped subset', () => {
    // Multiple projects under one Grove + a sibling Grove of a different
    // variant. Walker totals must reflect only the in-variant subset.
    const devGrove = createGrove('devspace', tmpMycoHome, { servedBy: 'service-dev' });
    const prodGrove = createGrove('prodspace', tmpMycoHome, { servedBy: 'service' });

    const dev1 = seedProject('dev-one');
    const dev2 = seedProject('dev-two');
    const prod1 = seedProject('prod-one');

    registerProjectInGrove(devGrove.id, {
      projectId: 'proj_dev_1', projectName: 'dev-one', projectRoot: dev1.projectRoot,
    }, tmpMycoHome);
    registerProjectInGrove(devGrove.id, {
      projectId: 'proj_dev_2', projectName: 'dev-two', projectRoot: dev2.projectRoot,
    }, tmpMycoHome);
    registerProjectInGrove(prodGrove.id, {
      projectId: 'proj_prod_1', projectName: 'prod-one', projectRoot: prod1.projectRoot,
    }, tmpMycoHome);

    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service-dev');
    expect(result.projectsVisited).toBe(2);
    // Neither prod project root should appear in any outcome.
    const visitedRoots = result.outcomes.map((o) => o.project.root);
    expect(visitedRoots).not.toContain(prod1.projectRoot);
  });
});
