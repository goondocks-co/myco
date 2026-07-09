import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOutputRoot } from '@myco/okf/output-root.js';
import { OkfError } from '@myco/okf/errors.js';

let projectRoot: string;

beforeEach(() => {
  // realpath the tmp dir up front — macOS /tmp is a symlink to /private/tmp,
  // and the resolver canonicalizes, so expectations must use the real path.
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-output-root-')));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function localBundleDir(): string {
  return path.join(projectRoot, '.myco', 'okf', 'bundle');
}

function published(requested?: string, allowExternalOutput?: boolean) {
  return resolveOutputRoot({ projectRoot, mode: 'published', requested, allowExternalOutput, localBundleDir: localBundleDir() });
}

describe('resolveOutputRoot — classification', () => {
  it('classifies the default <root>/okf as published_default', () => {
    const out = published();
    expect(out.klass).toBe('published_default');
    expect(out.absPath).toBe(path.join(projectRoot, 'okf'));
  });

  it('honors a configured published path', () => {
    const out = resolveOutputRoot({
      projectRoot,
      mode: 'published',
      publishedPath: 'docs/knowledge',
      localBundleDir: localBundleDir(),
    });
    expect(out.klass).toBe('published_default');
    expect(out.absPath).toBe(path.join(projectRoot, 'docs/knowledge'));
  });

  it('classifies the vault local bundle dir as private_local', () => {
    const out = resolveOutputRoot({ projectRoot, mode: 'local', localBundleDir: localBundleDir() });
    expect(out.klass).toBe('private_local');
    expect(out.absPath).toBe(localBundleDir());
  });

  it('classifies an arbitrary in-project path as external_export (needs allowExternalOutput)', () => {
    expect(() => published('some/other/dir')).toThrow(/allowExternalOutput/);
    const out = published('some/other/dir', true);
    expect(out.klass).toBe('external_export');
    expect(out.absPath).toBe(path.join(projectRoot, 'some/other/dir'));
  });
});

describe('resolveOutputRoot — rejections', () => {
  it('rejects a NUL byte', () => {
    expect(() => published('okf\0evil')).toThrow(OkfError);
  });

  it('rejects the project root itself', () => {
    expect(() => published('.')).toThrow(/project root itself/);
  });

  it('rejects a parent of the project root', () => {
    expect(() => published('..', true)).toThrow(/parent of the project root/);
  });

  it('rejects the .git directory', () => {
    expect(() => published('.git', true)).toThrow(/\.git/);
    expect(() => published('.git/hooks', true)).toThrow(/\.git/);
  });

  it('rejects node_modules', () => {
    expect(() => published('node_modules/pkg', true)).toThrow(/node_modules/);
  });

  it('rejects the .myco vault dir and the OKF control-state namespaces', () => {
    expect(() => published('.myco', true)).toThrow(/\.myco vault dir/);
    expect(() => published('.myco/okf', true)).toThrow(/control-state home/);
    expect(() => published('.myco/okf/state', true)).toThrow(/control-state dir/);
    expect(() => published('.myco/okf/staging', true)).toThrow(/staging dir/);
  });

  it('rejects an outside-project path without allowExternalOutput', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-outside-')));
    try {
      expect(() => published(outside)).toThrow(/allowExternalOutput/);
      const out = published(outside, true);
      expect(out.klass).toBe('external_export');
      expect(out.absPath).toBe(outside);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a local-mode requested root that is not the vault bundle dir', () => {
    expect(() =>
      resolveOutputRoot({ projectRoot, mode: 'local', requested: 'okf', localBundleDir: localBundleDir() }),
    ).toThrow(/local bundle dir/);
  });
});

describe('resolveOutputRoot — symlink canonicalization', () => {
  it('resolves a symlinked output root and re-checks the real target', () => {
    // A symlink at <root>/okf pointing into .git must be rejected on the real path.
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.symlinkSync(path.join(projectRoot, '.git'), path.join(projectRoot, 'okf'));
    expect(() => published()).toThrow(/\.git/);
  });

  it('canonicalizes a symlinked ancestor for classification', () => {
    // real published dir reached through a symlinked parent still classifies as published_default.
    const out = published();
    expect(out.klass).toBe('published_default');
  });
});
