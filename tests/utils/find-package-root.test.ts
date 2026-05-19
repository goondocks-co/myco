import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPackageRoot, findCorePackageRoot } from '@myco/utils/find-package-root.js';

function makeFixtureDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writePkg(dir: string, contents: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(contents) + '\n');
}

describe('findPackageRoot', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeFixtureDir('myco-find-pkg-root'); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns the nearest ancestor with package.json', () => {
    const pkgDir = path.join(tmp, 'pkg');
    writePkg(pkgDir, { name: 'anything' });
    const nested = path.join(pkgDir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(findPackageRoot(nested)).toBe(pkgDir);
  });

  it('returns the nearest package.json even if it is not core', () => {
    // From the binary's bin/ directory, the nearest package.json is the
    // platform sub-package's — findPackageRoot stops there. Use
    // findCorePackageRoot when you specifically want @goondocks/myco.
    const core = path.join(tmp, 'core');
    writePkg(core, { name: '@goondocks/myco' });
    const platform = path.join(core, 'node_modules', '@goondocks', 'myco-darwin-arm64');
    writePkg(platform, { name: '@goondocks/myco-darwin-arm64' });
    const binDir = path.join(platform, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    expect(findPackageRoot(binDir)).toBe(platform);
  });

  it('returns undefined when no package.json is found within the walk limit', () => {
    const deep = path.join(tmp, 'a', 'b', 'c', 'd');
    fs.mkdirSync(deep, { recursive: true });
    expect(findPackageRoot(deep)).toBeUndefined();
  });
});

describe('findCorePackageRoot', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeFixtureDir('myco-find-core-pkg'); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('walks past the platform sub-package and lands on core', () => {
    const core = path.join(tmp, 'core');
    writePkg(core, { name: '@goondocks/myco' });
    const platform = path.join(core, 'node_modules', '@goondocks', 'myco-darwin-arm64');
    writePkg(platform, { name: '@goondocks/myco-darwin-arm64' });
    const binDir = path.join(platform, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    expect(findCorePackageRoot(binDir)).toBe(core);
  });

  it('returns core directly when start dir is core itself', () => {
    const core = path.join(tmp, 'core');
    writePkg(core, { name: '@goondocks/myco' });
    expect(findCorePackageRoot(core)).toBe(core);
  });

  it('resolves core from inside a vendor/<arch>/ directory', () => {
    const core = path.join(tmp, 'core');
    writePkg(core, { name: '@goondocks/myco' });
    const vendorBin = path.join(core, 'vendor', 'darwin-arm64');
    fs.mkdirSync(vendorBin, { recursive: true });
    expect(findCorePackageRoot(vendorBin)).toBe(core);
  });

  it('skips a malformed package.json and continues walking', () => {
    const core = path.join(tmp, 'core');
    writePkg(core, { name: '@goondocks/myco' });
    const platform = path.join(core, 'node_modules', '@goondocks', 'myco-darwin-arm64');
    fs.mkdirSync(platform, { recursive: true });
    fs.writeFileSync(path.join(platform, 'package.json'), '{ not valid JSON');
    const binDir = path.join(platform, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    expect(findCorePackageRoot(binDir)).toBe(core);
  });

  it('returns undefined when no ancestor names @goondocks/myco', () => {
    const platform = path.join(tmp, 'something', 'myco-darwin-arm64');
    writePkg(platform, { name: '@goondocks/myco-darwin-arm64' });
    expect(findCorePackageRoot(path.join(platform, 'bin'))).toBeUndefined();
  });

  it('walks far enough to reach core from the binary\'s bin/ directory', () => {
    // <core>/node_modules/@goondocks/myco-<arch>/bin/<binary> places core
    // 4 ancestor steps above bin/. Pins the minimum required walk depth.
    const core = path.join(tmp, 'core');
    writePkg(core, { name: '@goondocks/myco' });
    const deep = path.join(core, 'node_modules', '@goondocks', 'myco-darwin-arm64', 'bin');
    fs.mkdirSync(deep, { recursive: true });
    expect(findCorePackageRoot(deep)).toBe(core);
  });

  it('resolves core from a sibling platform package in the source monorepo', () => {
    // `packages/myco/` (core) and `packages/myco-<arch>/bin/myco` (binary)
    // are siblings under `packages/` in a source checkout. Ancestor-walk
    // from the binary's bin/ never visits core; the sibling-package
    // fallback should pick it up via the `myco-<arch>` -> `myco/` mapping.
    const packagesDir = path.join(tmp, 'packages');
    const core = path.join(packagesDir, 'myco');
    writePkg(core, { name: '@goondocks/myco' });
    const platform = path.join(packagesDir, 'myco-darwin-arm64');
    writePkg(platform, { name: '@goondocks/myco-darwin-arm64' });
    const binDir = path.join(platform, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    expect(findCorePackageRoot(binDir)).toBe(core);
  });

  it('does not match a sibling package whose name is not @goondocks/myco', () => {
    // Guard against false positives — only `myco/` named `@goondocks/myco`
    // counts as core. A sibling named anything else must not resolve.
    const packagesDir = path.join(tmp, 'packages');
    const wrongCore = path.join(packagesDir, 'myco');
    writePkg(wrongCore, { name: 'some-other-package' });
    const platform = path.join(packagesDir, 'myco-darwin-arm64');
    writePkg(platform, { name: '@goondocks/myco-darwin-arm64' });
    const binDir = path.join(platform, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    expect(findCorePackageRoot(binDir)).toBeUndefined();
  });

  it('does not treat a non-platform @goondocks/myco-* package as the platform marker', () => {
    // `@goondocks/myco-shared` is a sibling but NOT a platform package —
    // the sibling-fallback should not engage off the wrong package.
    const packagesDir = path.join(tmp, 'packages');
    const shared = path.join(packagesDir, 'myco-shared');
    writePkg(shared, { name: '@goondocks/myco-shared' });
    expect(findCorePackageRoot(path.join(shared, 'src'))).toBeUndefined();
  });
});
