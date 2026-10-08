/**
 * The screens launcher: the shipped self-hosted server, in-process, serving the
 * BUILT dashboard over a seeded fixture.
 *
 *   bun tests/ui-screens/serve.ts [--port N]
 *
 * It composes a temporary dashboard directory from `packages/myco-server/ui/dist`
 * and, when present, the design specimen build at `target/ui-screens/specimen`
 * (served under `/specimen/`). It then boots the server on a temporary volume,
 * seeds `fixture.ts` with every time set back from the fixture's now, and prints
 * ONE JSON line on stdout:
 *
 *   {"url": ..., "ownerCookie": ..., "memberCookie": ..., "projects": [...], "now": ..., ...}
 *
 * Each cookie is a complete `name=value` pair signed with the fixture's session
 * secret: the owner's is an admin's, the member's a non-admin's, and the
 * stranger's a GitHub account no member is linked to. An owner POST
 * carries an `origin` header equal to `url`. The process serves until SIGINT or
 * SIGTERM, then stops the server and removes every temporary directory.
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { serve } from '@myco-server-worker/entry/bun.js';
import { fixtureNowAt } from './env.ts';
import { OWNER, READER, seedIdentities, seedThroughServer, STRANGER, type FixtureMember } from './fixture.ts';

/** The fixture's session secret. It signs only cookies for this throwaway volume. */
export const SCREENS_SESSION_SECRET = 'screens-session-secret-0123456789abcdef';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASHBOARD_DIST = path.join(REPO, 'packages', 'myco-server', 'ui', 'dist');
const SPECIMEN_DIST = path.join(REPO, 'target', 'ui-screens', 'specimen');

function portArgument(argv: string[]): number {
  const at = argv.indexOf('--port');
  if (at === -1) return 0;
  const port = Number(argv[at + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port needs a port number, got "${argv[at + 1]}"`);
  return port;
}

/** The dashboard build, plus the specimen under `specimen/` when it was built. */
function composeUiDir(root: string): { uiDir: string; specimen: boolean } {
  if (!fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'))) {
    throw new Error(`no dashboard build at ${path.relative(REPO, DASHBOARD_DIST)}; run \`npm run build:ui -w @goondocks/myco-server\` first`);
  }
  const uiDir = path.join(root, 'ui');
  fs.cpSync(DASHBOARD_DIST, uiDir, { recursive: true });
  const specimen = fs.existsSync(path.join(SPECIMEN_DIST, 'index.html'));
  if (specimen) fs.cpSync(SPECIMEN_DIST, path.join(uiDir, 'specimen'), { recursive: true });
  return { uiDir, specimen };
}

async function cookieFor(member: Pick<FixtureMember, 'githubSub' | 'login'>, now: number, deploymentId: string): Promise<string> {
  const value = await signSession(SCREENS_SESSION_SECRET, { aud: deploymentId, sub: member.githubSub, login: member.login, iat: now, exp: now + 12 * 3_600_000 });
  return `${SESSION_COOKIE}=${value}`;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-screens-'));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    const { uiDir, specimen } = composeUiDir(root);
    const databasePath = path.join(root, 'myco.sqlite');
    const sqlite = new Database(databasePath);
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
    const deploymentId = (sqlite.query("SELECT value FROM schema_meta WHERE key = 'deployment_id'").get() as { value: string }).value;
    sqlite.close();

    const now = Date.now();
    const tokens = await seedIdentities(databasePath, now);
    const started = await serve({
      harnessLaunch: async () => undefined,
      databasePath,
      blobDir: path.join(root, 'blobs'),
      uiDir,
      port: portArgument(process.argv.slice(2)),
      bind: 'loopback',
      transport: 'loopback',
      sourceFrom: 'socket',
      wakeLoop: false,
      originOf: (port) => `http://127.0.0.1:${port}`,
      SESSION_SECRET: SCREENS_SESSION_SECRET,
      SECRET_WRAP_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
      GITHUB_CLIENT_ID: 'screens-client',
      GITHUB_CLIENT_SECRET: 'screens-secret',
    });
    const url = `http://127.0.0.1:${started.port}`;
    const ownerCookie = await cookieFor(OWNER, now, deploymentId);
    const memberCookie = await cookieFor(READER, now, deploymentId);
    const strangerCookie = await cookieFor(STRANGER, now, deploymentId);

    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await started.stop().catch(() => undefined);
      cleanup();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());

    const fixtureNow = fixtureNowAt(now);
    const seeded = await seedThroughServer({ url, ownerCookie, databasePath, tokens, now: fixtureNow });
    process.stdout.write(`${JSON.stringify({ url, ownerCookie, memberCookie, strangerCookie, specimen, now: fixtureNow, ...seeded })}\n`);
  } catch (error) {
    cleanup();
    throw error;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`ui-screens launcher: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
