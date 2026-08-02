/**
 * Pi extension binary-resolution agreement.
 *
 * The Pi plugin template cannot import the contract (no-Myco-imports rule),
 * so it mirrors the layout and order. The layout copy is EXECUTED — extracted
 * from the template source, evaluated as a real module with collaborators
 * injected — and compared against `scripts/managed-paths.mjs`. The order is
 * asserted structurally. Extraction fails loudly on a signature change: the
 * literal replace no-ops and the TS annotations reach the generated `.mjs`,
 * which throws at import.
 */

import { afterEach, describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { managedBinaryPath as canonicalManagedBinaryPath } from '../../packages/myco/scripts/managed-paths.mjs';

const TEMPLATE = path.resolve('packages/myco/src/symbionts/templates/pi/plugin.ts');
const TEMPLATE_SOURCE = fs.readFileSync(TEMPLATE, 'utf8');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Extract a top-level function declaration by name, brace-matched. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} should exist in the Pi template`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/** Evaluate the template's layout copy with `join`/`homedir`/`process` injected. */
async function templateManagedBinaryPath(
  mycoHome: string,
  platform: NodeJS.Platform,
  localAppData?: string,
): Promise<string> {
  const declaration = extractFunction(TEMPLATE_SOURCE, 'managedBinaryPath')
    .replace('function managedBinaryPath(mycoHome: string): string {', 'function managedBinaryPath(mycoHome) {');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pi-layout-'));
  tmpDirs.push(dir);
  const modulePath = path.join(dir, 'layout.mjs');
  fs.writeFileSync(
    modulePath,
    [
      "import nodePath from 'node:path';",
      "import nodeOs from 'node:os';",
      'export function compute({ platform, localAppData, mycoHome }) {',
      "  const join = platform === 'win32' ? nodePath.win32.join : nodePath.posix.join;",
      '  const homedir = () => nodeOs.homedir();',
      '  const process = { platform, env: localAppData ? { LOCALAPPDATA: localAppData } : {} };',
      declaration,
      '  return managedBinaryPath(mycoHome);',
      '}',
    ].join('\n'),
  );
  const mod = await import(pathToFileURL(modulePath).href);
  return mod.compute({ platform, localAppData, mycoHome });
}

describe('Pi template managed-binary layout', () => {
  it('agrees with managed-paths.mjs on POSIX', async () => {
    const home = '/home/u/.myco';
    expect(await templateManagedBinaryPath(home, 'linux')).toBe(
      canonicalManagedBinaryPath(home, 'linux', undefined),
    );
  });

  it('agrees with managed-paths.mjs on win32 (explicit LOCALAPPDATA)', async () => {
    const localAppData = 'C:\\Users\\u\\AppData\\Local';
    expect(await templateManagedBinaryPath('C:\\ignored', 'win32', localAppData)).toBe(
      canonicalManagedBinaryPath('C:\\ignored', 'win32', localAppData),
    );
  });

  it('agrees on the win32 LOCALAPPDATA-absent fallback branch', async () => {
    const fromTemplate = await templateManagedBinaryPath('C:\\ignored', 'win32', undefined);
    const fromCanonical = canonicalManagedBinaryPath('C:\\ignored', 'win32', undefined);
    expect(fromTemplate).toBe(fromCanonical);
    expect(fromTemplate).toContain(path.win32.join('AppData', 'Local', 'Myco', 'bin', 'myco.exe'));
  });
});

describe('Pi template resolution order', () => {
  const resolver = extractFunction(TEMPLATE_SOURCE, 'resolveMycoBinary');

  it('project pin, machine pin, managed binary, bare name — in that order', () => {
    const projectPinAt = resolver.indexOf('".myco", "runtime.command"');
    const machinePinAt = resolver.indexOf('join(home, "runtime.command")');
    const managedAt = resolver.indexOf('managedBinaryPath(home)');
    const bareAt = resolver.indexOf('"myco.exe" : "myco"');
    expect(projectPinAt).toBeGreaterThan(-1);
    expect(machinePinAt).toBeGreaterThan(projectPinAt);
    expect(managedAt).toBeGreaterThan(machinePinAt);
    expect(bareAt).toBeGreaterThan(managedAt);
  });

  it('every pin read is trust-checked and both lookups share one home', () => {
    expect(resolver).not.toContain('readRuntimePin');
    expect(resolver.match(/readTrustedPin\(/g)?.length).toBe(2);
    // One directory-aware home feeds the machine pin AND the managed lookup.
    expect(resolver).toContain('const home = resolveMycoHome(directory);');
  });

  it('the managed candidate is gated on executability, not existence', () => {
    expect(resolver).toContain('isRunnableBinary(managed)');
  });
});
