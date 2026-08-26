/**
 * #909 requires the C-local conditions as startup CHECKS, not documentation.
 * Each one therefore gets a negative test that fails by name — a condition
 * nothing can violate in a test is a condition nobody is enforcing.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import {
  LOOPBACK_V4,
  LOOPBACK_V6,
  LoopbackContractError,
  assertLoopbackLiteral,
  assertBothLoopbackFamiliesBound,
  isAllowedLoopbackHost,
} from '@myco-server-worker/platform/bun/loopback.js';

describe('condition 1 — a loopback literal, never the name', () => {
  it('admits both literals', () => {
    expect(() => assertLoopbackLiteral(LOOPBACK_V4)).not.toThrow();
    expect(() => assertLoopbackLiteral(LOOPBACK_V6)).not.toThrow();
  });

  it("refuses the NAME 'localhost' and says why", () => {
    let thrown: LoopbackContractError | null = null;
    try { assertLoopbackLiteral('localhost'); } catch (err) { thrown = err as LoopbackContractError; }

    expect(thrown?.condition).toBe('loopback-literal');
    expect(thrown?.message).toContain('is a name, not a literal');
  });

  it('refuses a routable address', () => {
    expect(() => assertLoopbackLiteral('0.0.0.0')).toThrow(LoopbackContractError);
    expect(() => assertLoopbackLiteral('192.168.1.10')).toThrow(LoopbackContractError);
  });

  it('refuses the rest of 127.0.0.0/8 — the contract is two literals, not a range', () => {
    expect(() => assertLoopbackLiteral('127.0.0.2')).toThrow(LoopbackContractError);
  });
});

describe('condition 2 — both loopback families, or refuse to start', () => {
  it('admits both families bound', () => {
    expect(() => assertBothLoopbackFamiliesBound([LOOPBACK_V4, LOOPBACK_V6])).not.toThrow();
  });

  it('refuses when only IPv4 bound — this is the #835 hijack', () => {
    let thrown: LoopbackContractError | null = null;
    try { assertBothLoopbackFamiliesBound([LOOPBACK_V4]); } catch (e) { thrown = e as LoopbackContractError; }

    expect(thrown?.condition).toBe('both-families-bound');
    expect(thrown?.message).toContain(LOOPBACK_V6);
  });

  it('refuses when only IPv6 bound', () => {
    expect(() => assertBothLoopbackFamiliesBound([LOOPBACK_V6])).toThrow(/127\.0\.0\.1/);
  });

  it('refuses when nothing bound', () => {
    expect(() => assertBothLoopbackFamiliesBound([])).toThrow(LoopbackContractError);
  });
});

describe('condition 3 — Host-header allowlist', () => {
  it('admits the loopback authorities with the right port', () => {
    expect(isAllowedLoopbackHost('127.0.0.1:8787', 8787)).toBe(true);
    expect(isAllowedLoopbackHost('[::1]:8787', 8787)).toBe(true);
  });

  it('admits an authority with no port', () => {
    expect(isAllowedLoopbackHost('127.0.0.1', 8787)).toBe(true);
    expect(isAllowedLoopbackHost('[::1]', 8787)).toBe(true);
  });

  it("refuses the NAME, matching condition 1", () => {
    expect(isAllowedLoopbackHost('localhost:8787', 8787)).toBe(false);
  });

  it('refuses an attacker-chosen Host — the DNS-rebinding case the socket cannot see', () => {
    expect(isAllowedLoopbackHost('evil.example.com', 8787)).toBe(false);
    expect(isAllowedLoopbackHost('evil.example.com:8787', 8787)).toBe(false);
  });

  it('refuses a mismatched port', () => {
    expect(isAllowedLoopbackHost('127.0.0.1:9999', 8787)).toBe(false);
  });

  it('refuses a missing Host', () => {
    expect(isAllowedLoopbackHost(null, 8787)).toBe(false);
  });

  it('refuses an unbracketed IPv6 authority, which is not legal in Host', () => {
    expect(isAllowedLoopbackHost('::1', 8787)).toBe(false);
  });

  it('refuses a host that merely embeds a loopback literal', () => {
    expect(isAllowedLoopbackHost('127.0.0.1.evil.com', 8787)).toBe(false);
    expect(isAllowedLoopbackHost('notlocal127.0.0.1', 8787)).toBe(false);
  });
});

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** A migrated volume, matching the one `self-hosted-entry.test.ts` builds. */
function migratedVolume(): { databasePath: string; blobDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'myco-loopback-'));
  roots.push(root);
  const databasePath = join(root, 'myco.sqlite');
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.close();
  return { databasePath, blobDir: join(root, 'blobs') };
}

describe('serve() enforces the contract at startup', () => {
  it('binds BOTH loopback families and refuses a foreign Host', async () => {
    const { serve } = await import('@myco-server-worker/entry/bun.js');

    const started = await serve({ ...migratedVolume(), sourceFrom: 'socket', port: 0 });
    try {
      // Both families answer. A half-bound surface is what #835 was.
      for (const authority of [`127.0.0.1:${started.port}`, `[::1]:${started.port}`]) {
        const res = await fetch(`http://${authority}/health`, { headers: { host: authority } });
        expect(res.status).not.toBe(421);
      }

      // A foreign Host is refused even though the socket itself is loopback.
      const rebound = await fetch(`http://127.0.0.1:${started.port}/health`, {
        headers: { host: 'evil.example.com' },
      });
      expect(rebound.status).toBe(421);
    } finally {
      await started.stop();
    }
  });
});

describe('port 0 lands both families on ONE port', () => {
  it('the second family binds the port the kernel chose for the first', async () => {
    const { serve } = await import('@myco-server-worker/entry/bun.js');
    const started = await serve({ ...migratedVolume(), sourceFrom: 'socket', port: 0 });
    try {
      expect(started.port).toBeGreaterThan(0);
      // Two families on two ports would not be one deployment: both must answer
      // on the SAME reported port.
      for (const authority of [`127.0.0.1:${started.port}`, `[::1]:${started.port}`]) {
        const res = await fetch(`http://${authority}/health`, { headers: { host: authority } });
        expect(res.status).toBe(200);
      }
    } finally {
      await started.stop();
    }
  });
});

describe('bind mode reconciles the contract with a network namespace', () => {
  it("defaults to binding the loopback literals", async () => {
    const { serve } = await import('@myco-server-worker/entry/bun.js');
    const started = await serve({ ...migratedVolume(), sourceFrom: 'socket', port: 0 });
    try {
      for (const authority of [`127.0.0.1:${started.port}`, `[::1]:${started.port}`]) {
        const res = await fetch(`http://${authority}/health`, { headers: { host: authority } });
        expect(res.status).toBe(200);
      }
    } finally {
      await started.stop();
    }
  });

  it("bind 'all' still refuses a foreign Host — the namespace is not the only guard", async () => {
    const { serve } = await import('@myco-server-worker/entry/bun.js');
    const started = await serve({ ...migratedVolume(), sourceFrom: 'socket', port: 0, bind: 'all' });
    try {
      const ok = await fetch(`http://127.0.0.1:${started.port}/health`, {
        headers: { host: `127.0.0.1:${started.port}` },
      });
      expect(ok.status).toBe(200);

      // Published ports reach eth0, so the socket admits addresses the Host
      // allowlist must still reject.
      const rebound = await fetch(`http://127.0.0.1:${started.port}/health`, {
        headers: { host: 'evil.example.com' },
      });
      expect(rebound.status).toBe(421);
    } finally {
      await started.stop();
    }
  });

  it("bind 'all' does not weaken the refusal of the NAME", async () => {
    const { serve } = await import('@myco-server-worker/entry/bun.js');
    const started = await serve({ ...migratedVolume(), sourceFrom: 'socket', port: 0, bind: 'all' });
    try {
      const res = await fetch(`http://127.0.0.1:${started.port}/health`, {
        headers: { host: `localhost:${started.port}` },
      });
      expect(res.status).toBe(421);
    } finally {
      await started.stop();
    }
  });
});
