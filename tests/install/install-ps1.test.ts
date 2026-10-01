/**
 * `docs/install.ps1`, the Windows installer, never chooses a Myco 2.x release.
 *
 * It sets up Myco 1.4 (its binary, then `myco service install`), so a 2.x tag
 * must never reach that flow, on either channel. The script's own release
 * selection and its refusal are run in PowerShell with the GitHub read stubbed:
 * a 1.x release is chosen past any 2.x tag, and with only 2.x on offer it says
 * Myco 2.0 on Windows isn't supported by this installer yet and exits 1.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'docs', 'install.ps1'), 'utf8');
const PWSH = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout.trim();

/** The script from its release selection through its refusal: everything that decides which tag it installs. */
function selectionBlock(): string {
  const start = SCRIPT.indexOf('$MaxMajor = 1');
  const end = SCRIPT.indexOf('Write-Host "Found: $tag"');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return SCRIPT.slice(start, end);
}

const release = (tag: string, prerelease = false) => ({ tag_name: tag, prerelease, draft: false });

/** Runs the selection against `releases` on `channel`, with the GitHub read answering them; prints the tag chosen. */
function select(releases: unknown[], channel: 'stable' | 'beta'): { status: number | null; out: string } {
  const program = [
    `$Channel = '${channel}'`,
    `$Repo = 'goondocks-co/myco'`,
    `function Invoke-GhApi { param([string]$Url) return [PSCustomObject]@{ Content = '${JSON.stringify(releases).replace(/'/g, "''")}' } }`,
    selectionBlock(),
    'Write-Output "CHOSEN $tag"',
  ].join('\n');
  const run = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: program, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('the Windows installer', () => {
  it.skipIf(PWSH === '')('chooses a 1.x release past any 2.x tag, on either channel, and says 2.0 is not for this installer', () => {
    const releases = [release('myco/v2.0.0-beta.1', true), release('myco/v2.0.0'), release('myco/v1.4.8'), release('myco/v1.4.9-beta.1', true)];
    const stable = select(releases, 'stable');
    expect(stable.status).toBe(0);
    expect(stable.out).toContain('CHOSEN myco/v1.4.8');
    expect(stable.out).toContain("Myco 2.0 on Windows isn't supported by this installer yet.");
    const beta = select(releases, 'beta');
    expect(beta.out).toContain('CHOSEN myco/v1.4.9-beta.1');
    expect(beta.out).not.toContain('CHOSEN myco/v2');
  });

  it.skipIf(PWSH === '')('installs nothing and exits 1 when only Myco 2.x is on offer', () => {
    const only2 = select([release('myco/v2.0.0-beta.1', true), release('myco/v2.0.0')], 'beta');
    expect(only2.status).toBe(1);
    expect(only2.out).toContain("Myco 2.0 on Windows isn't supported by this installer yet.");
    expect(only2.out).not.toContain('CHOSEN');
  });

  it.skipIf(PWSH === '')('says nothing of 2.0 when no 2.x tag exists', () => {
    const run = select([release('myco/v1.4.8')], 'stable');
    expect(run.out).toContain('CHOSEN myco/v1.4.8');
    expect(run.out).not.toContain('Myco 2.0');
  });
});
