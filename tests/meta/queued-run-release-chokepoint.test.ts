/**
 * Meta gate: one function owns a harness run's credential, and one guard keys
 * every terminal write to it.
 *
 * The rule: a run's credential is revoked at the moment its row stops naming
 * it, and at no other moment. Two things make that true and are held here — a
 * queued row goes terminal only through `endQueuedRun`, which retires what the
 * row names as it ends it, and `revokeCredentialOfMember` is reached for a
 * harness credential only from the one function that owns the rule and from
 * the release a terminal run already goes through.
 *
 * A credential revoked anywhere else is one revoked while a row still names it;
 * a row moved anywhere else is one whose credential nothing retires.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../packages/myco-server/src/', import.meta.url));

/** Where each may be named: its own definition, and the chokepoint that pairs it with the release. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'failQueuedRun': ['core/runs.ts', 'core/harness.ts'],
  'skipQueued': ['core/runs.ts', 'core/harness.ts'],
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Where a harness credential may be revoked: the rule's owner, and the release a terminal run goes through. */
const REVOKE_CALLERS: readonly string[] = ['core/harness.ts', 'core/release.ts'];

describe('meta: ending a queued run', () => {
  it('happens only through the release that retires what the row holds', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const source = readFileSync(file, 'utf8');
      const relative = file.slice(SRC.length);
      for (const [name, allowed] of Object.entries(ALLOWED)) {
        if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) continue;
        if (!allowed.includes(relative)) offenders.push(`${relative}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names the chokepoint in the one file allowed to call the transitions', () => {
    const harness = readFileSync(join(SRC, 'core', 'harness.ts'), 'utf8');
    // Both transitions live inside the release; nothing else in this file reaches them.
    const release = harness.slice(harness.indexOf('export async function endQueuedRun'));
    const body = release.slice(0, release.indexOf('\n}\n') + 3);
    for (const name of Object.keys(ALLOWED)) {
      expect({ name, inside: new RegExp(`\\b${name}\\s*\\(`).test(body) }).toEqual({ name, inside: true });
      // One occurrence in the file, and it is that one.
      expect({ name, calls: harness.match(new RegExp(`\\b${name}\\s*\\(`, 'g'))?.length ?? 0 }).toEqual({ name, calls: 1 });
    }
    // The transition and the retirement are one act.
    expect(release).toContain('retireDispatchCredential(');
  });

  it('revokes a harness credential from the rule\'s owner and from the run release, and nowhere else', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const relative = file.slice(SRC.length);
      // The function's own definition is not a call of it.
      if (relative === 'auth/tokens.ts') continue;
      if (!/\brevokeCredentialOfMember\s*\(/.test(readFileSync(file, 'utf8'))) continue;
      if (!REVOKE_CALLERS.includes(relative)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('reaches it once in the owner, from the function that names the rule', () => {
    const harness = readFileSync(join(SRC, 'core', 'harness.ts'), 'utf8');
    expect(harness.match(/\brevokeCredentialOfMember\s*\(/g)).toHaveLength(1);
    const owner = harness.slice(harness.indexOf('async function retireDispatchCredential'));
    expect(owner.slice(0, owner.indexOf('\n}\n') + 3)).toContain('revokeCredentialOfMember(');
  });

  it('writes a run terminal in the api only through the wrapper that keys it to the row\'s credential', () => {
    // Structure, not proximity: the write and the release are reachable from
    // one function, so a route cannot write a run terminal beside the guard.
    const api = readFileSync(join(SRC, 'api', 'runs.ts'), 'utf8');
    // The wrapper's own span, by position: a line that merely reads the same as
    // one inside it is not inside it.
    const from = api.indexOf('async function endRunAsCaller');
    expect(from).toBeGreaterThan(-1);
    const to = from + api.slice(from).indexOf('\n}\n') + 3;
    expect(api.slice(from, to)).toContain('foreignCredentialAnswer(');

    const offenders: string[] = [];
    for (const file of files(join(SRC, 'api'))) {
      const relative = file.slice(SRC.length);
      const source = readFileSync(file, 'utf8');
      const inWrapper = (at: number) => relative === 'api/runs.ts' && at >= from && at < to;
      for (const name of ['applyRunUpdate', 'recordReplacedRun', 'failQueuedRun', 'skipQueued']) {
        for (const match of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
          const at = match.index;
          // A declaration is not a call.
          if (/\bfunction \s*$/.test(source.slice(Math.max(0, at - 20), at))) continue;
          if (!inWrapper(at)) offenders.push(`${relative}@${at}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runs both shipped images on the bun this repository pins', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const pinned = readFileSync(join(root, '.bun-version'), 'utf8').trim();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    for (const image of ['packages/myco-server/Dockerfile', 'packages/myco-server/harness/Dockerfile']) {
      const text = readFileSync(join(root, image), 'utf8');
      // The version is an argument with the pin as its default, and the image
      // is built from it — never a literal tag beside the pin.
      expect({ image, arg: new RegExp(`^ARG BUN_VERSION=${pinned}$`, 'm').test(text) }).toEqual({ image, arg: true });
      expect({ image, literal: /FROM oven\/bun:\d/.test(text) }).toEqual({ image, literal: false });
    }
  });
});
