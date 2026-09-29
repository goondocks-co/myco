/**
 * Every path that starts, spawns or installs the Myco 1.4 daemon, or rewrites
 * the agents' global config the way it does, reads the member-home predicate
 * (`member/home-role.ts`), so a 2.0 member home never runs 1.4 behaviour.
 *
 * The places a `daemon` argv is built are a closed set: a new one fails here
 * until it is gated or shown to lead to a gated start.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dir, '..', '..', 'packages', 'myco', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** The body of the function or method whose declaration starts with `signature`. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`no ${signature}`);
  let depth = 0;
  for (let i = source.indexOf('{', source.indexOf(')', start)); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

/** Every source file under `dir`, relative to it. */
const sources = (dir: string): string[] => (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).sort();

describe('the 1.4 daemon paths read the member-home predicate', () => {
  it('in the client that spawns it or asks a supervisor to start it', () => {
    const client = read('daemon/client.ts');
    expect(body(client, 'async ensureRunning(')).toContain('this.memberHomeRefusal() !== null');
    expect(body(client, 'async spawnDaemon(')).toContain('this.memberHomeRefusal() !== null');
    expect(body(client, '  memberHomeRefusal(): string | null')).toContain('isMemberHome(');
  });

  it('in the daemon itself, before it installs its service or does any work', () => {
    const main = read('daemon/main.ts');
    const entry = body(main, 'export async function main(');
    const gate = entry.indexOf('if (isMemberHome(mycoHome))');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(entry.indexOf('ensureSelfInstalledAsService'));
    expect(gate).toBeLessThan(entry.indexOf('stampHarnessRedirectEpoch(mycoHome)'));
    const legacy = entry.indexOf('if (unmovedLegacyVaults(mycoHome).length > 0)');
    expect(legacy).toBeGreaterThan(gate);
    expect(legacy).toBeLessThan(entry.indexOf('stampHarnessRedirectEpoch(mycoHome)'));
    expect(legacy).toBeLessThan(entry.indexOf('resolveDaemonServiceState('));
    const refusal = entry.slice(legacy, entry.indexOf('}', entry.indexOf('process.exit(', legacy)));
    expect(refusal).toContain('markAdoptFailed(mycoHome, process.platform, getPluginVersion()');
    expect(refusal).toContain('process.exit(1)');
    expect(body(read('service/self-install.ts'), 'export async function ensureSelfInstalledAsService(')).toContain('isMemberHome(mycoHome)');
  });

  it('in the global agent install every 1.4 entry point funnels through', () => {
    expect(body(read('cli/bootstrap.ts'), 'export function runSymbiontDetection(')).toContain('isMemberHome(');
  });

  it('in the credential-less entry points, which say what to use instead', () => {
    expect(read('cli/tool.ts')).toContain('daemonClient.memberHomeRefusal()');
    expect(read('mcp/stdio-bridge.ts')).toContain('client.memberHomeRefusal()');
    const shared = read('cli/shared.ts');
    expect(body(shared, 'export async function connectToDaemon(')).toContain('refuseForMemberHome()');
    expect(body(shared, 'export async function connectToGlobalDaemon(')).toContain('refuseForMemberHome()');
    expect(body(shared, 'function refuseForMemberHome(')).toContain('isMemberHome(mycoHome)');
  });

  it('in the service verbs, doctor\'s service reinstall and restart, none of which installs or starts the unit', () => {
    const service = read('cli/service.ts');
    const guard = body(service, 'export function assertSafeServiceMutation(');
    expect(guard).toContain("new Set(['install', 'start', 'restart', 'reconcile'])");
    expect(guard).toContain('isMemberHome(mycoHome)');
    const run = body(service, 'export async function run(');
    expect(run.indexOf('assertSafeServiceMutation(parsed')).toBeLessThan(run.indexOf("case 'install':"));
    const reinstall = read('cli/doctor-fixes.ts');
    const fix = reinstall.slice(reinstall.indexOf("'service-reinstall': async () => {"));
    expect(fix.indexOf("assertSafeServiceMutation({ action: 'install' }")).toBeGreaterThan(-1);
    expect(fix.indexOf("assertSafeServiceMutation({ action: 'install' }")).toBeLessThan(fix.indexOf('mgr.install('));
    const restart = body(read('cli/restart.ts'), 'export async function run(');
    expect(restart.indexOf('isMemberHome(mycoHome)')).toBeGreaterThan(-1);
    expect(restart.indexOf('isMemberHome(mycoHome)')).toBeLessThan(restart.indexOf("client.post('/api/restart'"));
    // Every place the service unit is built is one of the gated installs.
    const building = sources(SRC).filter((rel) => read(rel).includes('buildServiceSpec(') && rel !== 'service/spec-builder.ts');
    expect(building).toEqual(['cli/doctor-fixes.ts', 'cli/service.ts', 'service/self-install.ts']);
  });

  it('with every place a `daemon` argv is built accounted for', () => {
    const building = sources(SRC).filter((rel) => /'daemon'\]/.test(read(rel)));
    expect(building).toEqual([
      'config/loader.ts', // a config path, not a process
      'daemon/api/restart.ts', // a running daemon re-executing itself; a member home's daemon never gets this far
      'daemon/client.ts', // spawnDaemon, gated above
      'service/spec-builder.ts', // the unit's argv; every caller that installs it is gated (see 'in the service verbs')
      'upgrade/in-progress.ts', // a name for who started an update, not a process
      'upgrade/orchestrator.ts', // starts `myco daemon`, which exits at start for a member home
    ]);
  });
});
