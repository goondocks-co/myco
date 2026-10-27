import { CutoverBackup,cutoverBackupDir } from '@myco/member/cutover-backup.js';
import { legacyWindowsUnit } from '../helpers/legacy-windows-unit.ts';
import { refuseImportAfter } from '../setup/fixtures/interruption.js';
/**
 * `myco cutover`, against the real worker and a machine laid out the way a 1.4
 * install leaves it: a 1.4 home with a vault, its claim on the agents' settings,
 * its hooks and MCP entry in the agents' global config beside a hook of the
 * person's own, and its daemon's launchd unit beside other homes' units.
 *
 * What it is judged by:
 *   - capture moves to 2.0 in place: every Myco hook and the MCP entry are the
 *     member's, and the person's own hook is kept;
 *   - 1.4 is taken out of every place it registered, including agents 2.0
 *     does not capture, and cannot come back: its unit, found by reading the
 *     unit files, is booted out and removed, and the claim names the 2.0 home;
 *   - every settings file is backed up, with its mode, before its first change;
 *   - nothing 1.4 wrote as data is changed; a verified copy is what the import
 *     reads, and running it again changes nothing;
 *   - a dry run changes nothing and plans exactly what the real run does;
 *   - it stops before its first change, dry run or not, where another
 *     installation holds anything it would need to take.
 */
import { type CutoverDeps } from '@myco/cli/cutover.js';
import { Database } from 'bun:sqlite';
import { afterEach,beforeEach,describe,expect,it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { provisionGlobally } from '@myco/cli/member.js';
import { CREDENTIAL_FLAG } from '@myco/member/constants.js';
import { stopHomeDaemon } from '@myco/member/legacy-daemon-stop.js';
import { CLAUDE_PROJECT_MCP,LEGACY_REGISTRATIONS,scanLegacyRegistrations } from '@myco/member/legacy-registration-files.js';
import { listRegistryEntries,registryEntryPath,writeDeploymentMembership } from '@myco/member/registry.js';
import { resolveMachineIdPath } from '@myco/paths/home.js';
import { resolveServiceDaemonStatePath } from '@myco/paths/service.js';
import { resolvePackageRoot } from '@myco/symbionts/detect.js';
import { resolveManagedBinaryPath } from '@myco/symbionts/installer.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';
import { tempMycoHome,TEST_MACHINE_ID,type MemberRig } from '../member/helpers/server.js';

import { DAEMON_LABEL,machine,NOW_S,OTHER_DAEMON_LABEL,plist,PROJECT,readJson,SERVER,sha,WORKER_LABEL,writeJson,type Machine,type RunOpts } from './cutover-machine.js';

describe('myco cutover', () => {
  let m: Machine;
  let heldHome: string | undefined;
  beforeEach(async () => {
    m = await machine();
    heldHome = process.env.HOME;
    process.env.HOME = m.home;
  });
  afterEach(() => {
    if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome;
  });

  it.each([false, true])('restores the exact 1.x executable after replacement (retained slot %s)', async (retained) => {
    const { sandboxChildEnv } = await import('../../scripts/test-environment.mjs');
    const stable = path.join(m.legacyHome, 'bin', 'myco');
    const slot = path.join(m.legacyHome, 'bin', 'versions', '1.4.8', 'myco');
    const old = '#!/bin/sh\necho 1.4.8\n';
    fs.mkdirSync(path.dirname(stable), { recursive: true }); fs.writeFileSync(stable, old, { mode: 0o755 });
    if (retained) { fs.mkdirSync(path.dirname(slot), { recursive: true }); fs.copyFileSync(stable, slot); }
    writeJson(path.join(m.legacyHome, 'install.json'), { channel: 'stable', version: '1.4.8', bin: stable, binary_sha256: sha(stable) });
    const source = path.join(m.home, 'offline-source'); fs.mkdirSync(source);
    const asset = 'myco-' + process.platform + '-' + process.arch;
    fs.writeFileSync(path.join(source, 'fake.c'), '#include <stdio.h>\nint main(void){puts("2.0.0");return 0;}');
    const compiled = spawnSync('cc', ['-o', path.join(source, asset), path.join(source, 'fake.c')], { cwd: m.home, env: sandboxChildEnv(m.home), encoding: 'utf8' });
    expect({ status: compiled.status, stderr: compiled.stderr }).toEqual({ status: 0, stderr: '' });
    fs.writeFileSync(path.join(source, 'SHA256SUMS'), sha(path.join(source, asset)) + '  ' + asset + '\n');
    const childEnv = sandboxChildEnv(m.home, { MYCO_HOME: m.legacyHome, MYCO_INSTALL_FROM: source, MYCO_INSTALL_VERSION: '2.0.0' });
    const installed = spawnSync('sh', [path.resolve('docs/install.sh'), '--replace-1.4'], { cwd: m.home, env: childEnv, encoding: 'utf8' });
    expect(installed.status).toBe(0);
    expect(fs.readFileSync(stable, 'utf8')).not.toBe(old);
    if (retained) fs.unlinkSync(path.join(m.legacyHome, 'legacy-executable.json'));
    else {
      const decoy = path.join(m.legacyHome, 'bin', 'versions', '1.4.9', 'myco');
      fs.mkdirSync(path.dirname(decoy), { recursive: true }); fs.writeFileSync(decoy, 'another 1.x executable');
    }
    let backupHome = m.mycoHome;
    if (process.env.MYCO_CUTOVER_TEST_BINARY) {
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => m.rig.fetch(request) });
      const serverUrl = `http://127.0.0.1:${server.port}`;
      backupHome = path.join(m.home, 'compiled-member');
      writeDeploymentMembership({ serverUrl, token: m.rig.token, tokenId: m.rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome: backupHome });
      fs.writeFileSync(resolveMachineIdPath(backupHome), TEST_MACHINE_ID);
      const tools = path.join(m.home, 'tools'); fs.mkdirSync(tools);
      fs.writeFileSync(path.join(tools, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      try {
        const child = Bun.spawn([process.env.MYCO_CUTOVER_TEST_BINARY, 'cutover', '--server', serverUrl, '--legacy-home', m.legacyHome], {
          cwd: m.home, stdout: 'pipe', stderr: 'pipe',
          env: sandboxChildEnv(m.home, { MYCO_HOME: backupHome, MYCO_LAUNCH_AGENTS_DIR: m.agentsDir, PATH: tools + path.delimiter + process.env.PATH }),
        });
        const timeout = setTimeout(() => child.kill(), 20_000);
        try {
          const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
          expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        } finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill(); await child.exited; } }
      } finally { await server.stop(true); }
    } else {
      const result = await m.run(); expect(result.ok).toBe(true);
    }
    const [folder] = fs.readdirSync(path.join(backupHome, 'backups'));
    const recipe = fs.readFileSync(path.join(backupHome, 'backups', folder, 'restore.md'), 'utf8');
    expect(recipe).toContain('replaces Myco 2.0 at ' + stable);
    const commands = [...recipe.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
    const undo = spawnSync('sh', ['-c', commands], { cwd: m.home, env: childEnv, encoding: 'utf8' });
    expect({ status: undo.status, stderr: undo.stderr }).toEqual({ status: 0, stderr: '' });
    expect(fs.readFileSync(path.join(m.agentsDir, DAEMON_LABEL + '.plist'), 'utf8')).toContain(stable);
    expect(fs.readFileSync(stable, 'utf8')).toBe(old);
    expect(fs.statSync(stable).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(source, asset))).toEqual(fs.readFileSync(path.join(m.legacyHome, 'bin', 'versions', '2.0.0', 'myco')));
  });

  const settingsFile = () => path.join(m.home, '.claude', 'settings.json');
  const claimOwner = (claimsHome: string) => (readJson(path.join(claimsHome, 'claims', 'symbiont-config.json')) as { owner: string }).owner;
  const bootouts = () => m.launchctl.calls.filter((c) => c[0] === 'bootout').map((c) => c[c.length - 1].split('/').pop());
  /** Every copy the cutovers so far hold of `file`, from their manifests. */
  const backupsOf = (file: string): string[] => {
    const root = path.join(m.mycoHome, 'backups');
    const folders = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('cutover-')) : [];
    return folders.flatMap((folder) => (readJson(path.join(root, folder, 'manifest.json')).entries as Array<{ original: string; backup: string }>)
      .filter((e) => e.original === file).map((e) => e.backup));
  };
  /** Every file under `dir`, with a digest of its bytes. */
  const tree = (dir: string): Record<string, string> => Object.fromEntries((fs.readdirSync(dir, { recursive: true }) as string[]).sort()
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
    .map((rel) => [rel, sha(path.join(dir, rel))]));


  for (const [kind, fix] of [
    ['edge', 'Cloudflare Security Events'], ['edge-mid', 'Cloudflare Security Events'], ['worker', 'check this machine'], ['server', 'check its health'],
    ['refused', 'correct the source record'], ['large', 'reduce that record'],
    ['interrupted', 'resume safely'],
  ] as const) {
    it(`prints grouped causes and stoppedBy when cutover meets ${kind}`, async () => {
      const controller = new AbortController();
      const edge = refuseImportAfter(2, m.rig.fetch);
      const fetch: MemberRig['fetch'] = async (input, init) => {
        const route = new URL(new Request(input, init).url).pathname;
        if (kind === 'edge-mid' && ['/import/plan', '/events', '/blobs'].includes(route)) return edge.fetchImpl(input, init);
        if (kind === 'worker' && route === '/import/plan') return new Response('forbidden', { status: 403, headers: { 'x-myco-protocol': '1' } });
        if (route === '/import/plan' && (kind === 'edge' || kind === 'server')) return new Response('upstream', { status: kind === 'edge' ? 403 : 500 });
        if (route === '/events') {
          if (kind === 'interrupted') { controller.abort(); throw new DOMException('stopped', 'AbortError'); }
          if (kind === 'refused' || kind === 'large') return Response.json({ persisted: false, code: kind === 'large' ? 'body_cap' : 'invalid_field', reason: 'fixture' }, { headers: { 'x-myco-protocol': '1' } });
        }
        return m.rig.fetch(input, init);
      };
      const result = await m.run([], { fetch, signal: controller.signal });
      expect(result.ok).toBe(false);
      const output = result.out.join('\n');
      expect(output).toMatch(/\d+ records? or uploads?:/);
      expect(output).toContain(fix);
      if (kind === 'edge-mid' || kind === 'refused' || kind === 'large') expect(output).not.toContain('stoppedBy:');
      else expect(output.split('\n').filter((l) => l.includes('stoppedBy:')).join('\n')).toContain(fix);
      if (kind === 'edge') expect(output).toContain('likely a security rule');
      if (kind === 'interrupted') {
        const resumed = await m.run();
        expect(resumed.ok).toBe(true);
      }
    });
  }

  it('moves capture to 2.0 in place, takes 1.4 out for good, keeps the vault as it was, and brings its history; again changes nothing', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'config.yaml'), 'capture:\n  plan_dirs: [custom-plans]\n');
    const vaultBytes = sha(m.vault);
    const settingsBytes = fs.readFileSync(settingsFile(), 'utf8');
    fs.chmodSync(settingsFile(), 0o600);
    const first = await m.run();
    expect(first.err).toEqual([]);
    expect(first.ok).toBe(true);
    expect(first.out.join('\n')).toContain('My machines › Its settings');
    expect(first.out.join('\n')).toContain(`${SERVER}/me/machines`);

    // The folder is connected; the claim names the 2.0 home, so a 1.4 daemon that comes back defers.
    expect(listRegistryEntries(m.mycoHome).map((e) => [e.root, e.projectId])).toEqual([[m.root, PROJECT]]);
    expect(claimOwner(m.legacyHome)).toBe(m.mycoHome);

    // The 1.4 daemon's unit, found by reading the unit files, is booted out and removed; no other unit is touched.
    expect(bootouts()).toEqual([DAEMON_LABEL]);
    expect(fs.readdirSync(m.agentsDir).sort()).toEqual([`${OTHER_DAEMON_LABEL}.plist`, `${WORKER_LABEL}.plist`].sort());

    // Every Myco hook is the member's; the person's own is kept; the MCP entry is the member's.
    const commands = hookCommands(readJson(settingsFile()).hooks);
    expect(commands).toContain('echo mine');
    expect(commands.filter((c) => c.includes('hook ')).every((c) => c.includes(CREDENTIAL_FLAG))).toBe(true);
    expect(commands.some((c) => c.includes(path.join(m.legacyHome, 'bin')))).toBe(false);
    const mcp = (readJson(path.join(m.home, '.claude.json')).mcpServers as Record<string, Record<string, unknown>>).myco;
    expect(mcp.url).toBe(`${SERVER}/mcp`);

    // Each settings file was backed up, with its mode, before its first change; the file keeps its mode.
    const [backup] = backupsOf(settingsFile());
    expect(backup.startsWith(path.join(m.mycoHome, 'backups', 'cutover-'))).toBe(true);
    expect(backup.endsWith(settingsFile())).toBe(true);
    expect(fs.readFileSync(backup, 'utf8')).toBe(settingsBytes);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
    expect(backupsOf(path.join(m.home, '.claude.json'))).toHaveLength(1);
    expect(first.out.join('\n')).toContain(`to ${path.join(m.mycoHome, 'backups', 'cutover-')}`);
    expect(first.out.join('\n')).toContain(`     ${settingsFile()}`);
    expect(fs.readdirSync(path.join(m.home, '.claude')).some((n) => n.includes('bak'))).toBe(false);

    // The vault is untouched; a verified copy sits beside it; the history arrived, with its title.
    expect(sha(m.vault)).toBe(vaultBytes);
    const copies = fs.readdirSync(path.join(m.legacyHome, 'backups'));
    expect(copies.length).toBe(1);
    expect(fs.existsSync(path.join(m.legacyHome, 'backups', copies[0], 'grove_a', 'myco.db'))).toBe(true);
    const sqlite = m.rig.env.sqlite;
    expect(sqlite.query(`SELECT title FROM sessions WHERE project_id = ?`).all(PROJECT)).toEqual([{ title: 'A 1.4 session' }]);
    expect(sqlite.query(`SELECT id FROM spores WHERE project_id = ?`).all(PROJECT)).toEqual([{ id: 'gotcha-1' }]);

    const tables = ['sessions', 'prompt_batches', 'spores', 'events', 'transcripts'];
    const snapshot = () => Object.fromEntries(tables.map((t) => [t, m.rig.rows(t)]));
    const before = snapshot();
    const settingsAfter = fs.readFileSync(settingsFile(), 'utf8');
    const again = await m.run();
    expect(again.ok).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(settingsAfter);
    expect(fs.readdirSync(path.join(m.legacyHome, 'backups')).length).toBe(1);
    expect(bootouts()).toEqual([DAEMON_LABEL]);
    // A file the run left as it was keeps no second copy.
    expect(backupsOf(settingsFile())).toHaveLength(1);
    expect(again.out.join('\n')).not.toContain('backed up');
  });

  it('preserves early-alpha member configs inside a connected project', async () => {
    // Repository member hooks and user files remain outside global provisioning ownership.
    const memberHook = `${path.join(m.mycoHome, 'bin', 'myco')} hook stop --symbiont claude-code ${CREDENTIAL_FLAG} registry --myco-managed`;
    writeJson(path.join(m.root, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: memberHook }] }] } });
    fs.writeFileSync(path.join(m.root, 'notes.md'), 'mine\n');
    const before = tree(m.root);
    const result = await m.run();
    expect(result.ok).toBe(true);
    const after = tree(m.root);
    expect(after).toEqual(before);
  });

  it('plans on a dry run exactly the changes the real run makes, and makes none of them', async () => {
    // Antigravity's 1.4 plugin: its hooks file, and the manifest that goes with it.
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const plugin = path.join(m.home, '.gemini', 'config', 'plugins', 'myco');
    writeJson(path.join(plugin, 'hooks.json'), { myco: { Stop: [{ type: 'command', command: `${legacyBin} hook stop --symbiont antigravity --myco-managed` }] } });
    writeJson(path.join(plugin, 'plugin.json'), { name: 'myco' });
    const settings = fs.readFileSync(settingsFile(), 'utf8');
    const vaultBytes = sha(m.vault);
    const events = m.rig.rows('events');
    const dry = await m.run(['--dry-run']);
    expect(dry.ok).toBe(true);
    expect(dry.out.join('\n')).toContain(`would connect ${m.root}`);
    expect(dry.out.join('\n')).toContain(`would stop and remove ${DAEMON_LABEL}`);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(settings);
    expect(claimOwner(m.legacyHome)).toBe(m.legacyHome);
    expect(listRegistryEntries(m.mycoHome)).toEqual([]);
    expect(fs.existsSync(path.join(m.legacyHome, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(m.mycoHome, 'backups'))).toBe(false);
    expect(m.launchctl.calls).toEqual([]);
    expect(sha(m.vault)).toBe(vaultBytes);
    expect(m.rig.rows('events')).toBe(events);
    expect(m.done).toEqual([]);

    const real = await m.run();
    expect(real.ok).toBe(true);
    expect(m.planned[0].length).toBeGreaterThan(0);
    expect(m.planned[0].filter((o) => o.includes(plugin))).toHaveLength(2);
    expect(m.done).toEqual(m.planned[0]);
    expect(m.planned[1]).toEqual(m.planned[0]);
    expect(fs.existsSync(path.join(plugin, 'hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(plugin, 'plugin.json'))).toBe(false);
  });

  it('removes 1.4 from agents 2.0 does not capture and from every place 1.4.8 wrote, keeping the person\'s own entries', async () => {
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const copilotHooks = path.join(m.home, '.copilot', 'hooks', 'myco-hooks.json');
    const copilotMcp = path.join(m.home, '.copilot', 'mcp-config.json');
    const vscodeMcp = path.join(m.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    const clinePlugin = path.join(m.home, '.cline', 'plugins', 'myco.ts');
    writeJson(copilotHooks, { version: 1, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${legacyBin} hook session-start --symbiont copilot --myco-managed` }] }] } });
    writeJson(copilotMcp, { mcpServers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] }, mine: { command: 'mine' } } });
    fs.chmodSync(copilotMcp, 0o640);
    writeJson(vscodeMcp, { servers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] } } });
    fs.mkdirSync(path.dirname(clinePlugin), { recursive: true });
    fs.writeFileSync(clinePlugin, '// myco:plugin-marker — Myco owns this file\nexport default {};\n');
    // 1.4.8 wrote Claude Code's MCP entry into settings.json; 2.0 writes ~/.claude.json.
    writeJson(settingsFile(), { ...readJson(settingsFile()), mcpServers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] } } });

    const dry = await m.run(['--dry-run']);
    expect(dry.ok).toBe(true);
    expect(dry.out.join('\n')).toContain(`GitHub Copilot: would remove the \`myco\` MCP entry from ${copilotMcp}; GitHub Copilot is no longer captured by Myco 2.0`);

    const result = await m.run();
    expect(result.err).toEqual([]);
    expect(result.ok).toBe(true);
    const said = result.out.join('\n');
    expect(said).toContain(`GitHub Copilot: removed 1 1.4 hook from ${copilotHooks}; GitHub Copilot is no longer captured by Myco 2.0`);
    expect(said).toContain(`Cline: removed ${clinePlugin}`);
    expect(said).not.toContain('Cline is no longer captured');
    expect(hookCommands(readJson(copilotHooks).hooks)).toEqual([]);
    expect(readJson(copilotMcp).mcpServers).toEqual({ mine: { command: 'mine' } });
    expect(fs.statSync(copilotMcp).mode & 0o777).toBe(0o640);
    expect(backupsOf(copilotMcp)).toHaveLength(1);
    expect(readJson(vscodeMcp).servers).toEqual({});
    expect(fs.existsSync(clinePlugin)).toBe(false);
    expect(backupsOf(clinePlugin)).toHaveLength(1);
    expect(readJson(settingsFile()).mcpServers).toEqual({});
  });

  it('keeps a 2.0 member plugin, and refuses another home\'s plugin', async () => {
    const clinePlugin = path.join(m.home, '.cline', 'plugins', 'myco.ts');
    fs.mkdirSync(path.dirname(clinePlugin), { recursive: true });
    const memberPlugin = `// myco:plugin-marker — Myco owns this file\nconst args = ["hook", verb, "--symbiont", "cline", "${CREDENTIAL_FLAG}", "registry"];\n`;
    fs.writeFileSync(clinePlugin, memberPlugin);
    const kept = await m.run();
    expect(kept.err).toEqual([]);
    expect(fs.readFileSync(clinePlugin, 'utf8')).toBe(memberPlugin);

    const other = await machine();
    try {
      process.env.HOME = other.home;
      const foreignPlugin = path.join(other.home, '.cline', 'plugins', 'myco.ts');
      fs.mkdirSync(path.dirname(foreignPlugin), { recursive: true });
      const foreignHome = path.join(other.home, 'other-install');
      fs.mkdirSync(foreignHome);
      fs.writeFileSync(foreignPlugin, `// myco:plugin-marker\nconst bin = "${foreignHome}/bin/myco";\n`);
      const refused = await other.run();
      expect(refused.ok).toBe(false);
      expect(refused.err.join('\n')).toContain(`${foreignPlugin} holds a Myco plugin of another installation`);
      expect(fs.existsSync(foreignPlugin)).toBe(true);
    } finally {
      process.env.HOME = m.home;
    }
  });

  it('takes 1.4 out of each connected folder, Claude Code\'s per-folder entries and the skill links', async () => {
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const projectSettings = path.join(m.root, '.claude', 'settings.json');
    const projectMcp = path.join(m.root, '.mcp.json');
    writeJson(projectSettings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${legacyBin} hook stop --symbiont claude-code --myco-managed` }, { type: 'command', command: 'echo mine' }] }] } });
    writeJson(projectMcp, { mcpServers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] }, mine: { command: 'mine' } } });
    const claudeJson = path.join(m.home, '.claude.json');
    writeJson(claudeJson, { ...readJson(claudeJson), projects: { [m.root]: { mcpServers: { myco: { command: legacyBin, args: ['mcp'] } }, allowedTools: ['x'] } } });
    // A 1.4 skill link, where 2.0 has the same skill, and one where it has none.
    for (const name of ['myco', 'myco-old']) fs.mkdirSync(path.join(m.legacyHome, 'skills', name), { recursive: true });
    fs.mkdirSync(path.join(m.mycoHome, 'skills', 'myco'), { recursive: true });
    const skills = path.join(m.home, '.claude', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    for (const name of ['myco', 'myco-old']) fs.symlinkSync(path.join(m.legacyHome, 'skills', name), path.join(skills, name));

    const dry = (await m.run(['--dry-run'])).out.join('\n');
    expect(dry).toContain(`would point the skill link ${path.join(skills, 'myco')} (now to ${path.join(m.legacyHome, 'skills', 'myco')}) at ${path.join(m.mycoHome, 'skills', 'myco')}`);
    expect(dry).toContain(`would remove the skill link ${path.join(skills, 'myco-old')} (to ${path.join(m.legacyHome, 'skills', 'myco-old')}); ${m.mycoHome} has no such skill`);
    const result = await m.run();
    expect(result.err).toEqual([]);
    expect(result.ok).toBe(true);
    expect(hookCommands(readJson(projectSettings).hooks)).toEqual(['echo mine']);
    expect(readJson(projectMcp).mcpServers).toEqual({ mine: { command: 'mine' } });
    const projects = readJson(claudeJson).projects as Record<string, Record<string, unknown>>;
    expect(projects[m.root]).toEqual({ mcpServers: {}, allowedTools: ['x'] });
    expect(fs.readlinkSync(path.join(skills, 'myco'))).toBe(path.join(m.mycoHome, 'skills', 'myco'));
    expect(fs.existsSync(path.join(skills, 'myco-old'))).toBe(false);
    // Every one of them, and the unit, the claim, the pin and the folder's registry entry, is in the manifest; restore.md undoes them.
    const [folder] = fs.readdirSync(path.join(m.mycoHome, 'backups'));
    const dir = path.join(m.mycoHome, 'backups', folder);
    const entries = (readJson(path.join(dir, 'manifest.json')).entries as Array<Record<string, string>>);
    const originals = entries.map((e) => e.original);
    expect(originals).toEqual(expect.arrayContaining([projectSettings, projectMcp, claudeJson, path.join(skills, 'myco'), path.join(skills, 'myco-old'),
      path.join(m.agentsDir, `${DAEMON_LABEL}.plist`), path.join(m.legacyHome, 'claims', 'symbiont-config.json'), path.join(m.legacyHome, 'runtime.home')]));
    expect(entries.find((e) => e.original === path.join(skills, 'myco-old'))?.link).toBe(path.join(m.legacyHome, 'skills', 'myco-old'));
    expect(fs.existsSync(entries.find((e) => e.original === path.join(m.agentsDir, `${DAEMON_LABEL}.plist`))!.backup)).toBe(true);
    const restore = fs.readFileSync(path.join(dir, 'restore.md'), 'utf8');
    expect(restore).toContain(`ln -sfn '${path.join(m.legacyHome, 'skills', 'myco-old')}' '${path.join(skills, 'myco-old')}'`);
    expect(restore).toContain(`rm -f '${path.join(m.legacyHome, 'runtime.home')}'`);
    expect(restore).toContain(`'${path.join(m.agentsDir, `${DAEMON_LABEL}.plist`)}'`);
    expect(result.out.join('\n')).toContain(`run the commands in ${path.join(dir, 'restore.md')}`);
  });

  it('plans a removal for every MCP file of an agent that provisioning does not write (Cline)', async () => {
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const written = path.join(m.home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
    const other = path.join(m.home, '.cline', 'mcp.json');
    for (const file of [written, other]) writeJson(file, { mcpServers: { myco: { type: 'stdio', command: legacyBin, args: ['mcp'] }, mine: { command: 'mine' } } });
    const result = await m.run([], { agents: ['claude-code', 'cline'] });
    expect(result.err).toEqual([]);
    expect(result.ok).toBe(true);
    // Provisioning wrote the member's entry into the one file it writes; the other file's 1.4 entry was planned and removed.
    const member = (readJson(written).mcpServers as Record<string, Record<string, unknown>>).myco;
    expect(JSON.stringify(member)).toContain(CREDENTIAL_FLAG);
    expect(readJson(other).mcpServers).toEqual({ mine: { command: 'mine' } });
    expect(m.planned[0].some((o) => o.startsWith(`remove ${other} :: mcp`))).toBe(true);
    expect(m.planned[0].some((o) => o.startsWith(`remove ${written} `))).toBe(false);
    expect(m.done).toEqual(m.planned[0]);
  });

  it('leaves no empty hook group or event behind, and keeps every entry that is not Myco\'s', async () => {
    const legacy = (event: string) => ({ type: 'command', command: `${path.join(m.legacyHome, 'bin', 'myco')} hook ${event} --symbiont claude-code --myco-managed` });
    const projectSettings = path.join(m.root, '.claude', 'settings.json');
    writeJson(projectSettings, {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        SessionStart: [{ hooks: [legacy('session-start')] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [legacy('pre-tool-use')] }, { matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }],
        Stop: [{ hooks: [legacy('stop'), { type: 'command', command: 'echo mine' }] }],
      },
    });
    const result = await m.run();
    expect(result.ok).toBe(true);
    expect(readJson(projectSettings)).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
    });
  });

  it('points a connected folder\'s runtime pin at the 2.0 binary when it names a 1.4 binary, and backs it up', async () => {
    const pin = path.join(m.root, '.myco', 'runtime.command');
    fs.mkdirSync(path.dirname(pin), { recursive: true });
    fs.writeFileSync(pin, `${path.join(m.legacyHome, 'bin', 'myco')}\n`, { mode: 0o644 });
    const dry = await m.run(['--dry-run']);
    expect(dry.out.join('\n')).toContain(`would point ${pin} (now \`${path.join(m.legacyHome, 'bin', 'myco')}\`, a 1.4 binary) at ${resolveManagedBinaryPath(m.mycoHome)}`);
    const result = await m.run();
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(pin, 'utf8').trim()).toBe(resolveManagedBinaryPath(m.mycoHome));
    expect(backupsOf(pin)).toHaveLength(1);
  });

  it('fails when a 1.4 registration is still there once every change is made', async () => {
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    const copilotMcp = path.join(m.home, '.copilot', 'mcp-config.json');
    const provision: CutoverDeps['provision'] = (agent, root, home, opts) => {
      const outcome = provisionGlobally(agent, root, home, opts);
      writeJson(copilotMcp, { mcpServers: { myco: { command: legacyBin, args: ['mcp'] } } });
      return outcome;
    };
    const result = await m.run([], { provision });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain(`${copilotMcp} still holds a 1.4 registration`);
    expect(bootouts()).toEqual([]);
  });

  it('fails the run when the vault import is refused outright', async () => {
    const olderServer: MemberRig['fetch'] = async (input, init) => {
      const res = await m.rig.fetch(input, init);
      if (!String(input).endsWith('/import/plan')) return res;
      const body = await res.json() as Record<string, unknown>;
      delete body.sessions;
      return Response.json(body);
    };
    const result = await m.run([], { fetch: olderServer });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('update the Deployment');
  });

  it('passes an MCP entry for its own Deployment before the folder is connected', async () => {
    expect((await m.run()).ok).toBe(true);
    for (const entry of listRegistryEntries(m.mycoHome)) fs.rmSync(registryEntryPath(entry.root!, m.mycoHome));
    const again = await m.run(['--dry-run']);
    expect(again.err).toEqual([]);
    expect(again.ok).toBe(true);
  });

  it('removes the unit file it read even when the file is named for another label', async () => {
    fs.renameSync(path.join(m.agentsDir, `${DAEMON_LABEL}.plist`), path.join(m.agentsDir, 'co.goondocks.myco.renamed.plist'));
    const result = await m.run();
    expect(result.ok).toBe(true);
    expect(bootouts()).toEqual([DAEMON_LABEL]);
    expect(fs.existsSync(path.join(m.agentsDir, 'co.goondocks.myco.renamed.plist'))).toBe(false);
  });

  it('backs up and unregisters a Windows daemon launcher after its own home drains', async () => {
    const dir = path.join(m.home, 'windows-units');
    const task = legacyWindowsUnit(dir, m.legacyHome);
    const options: RunOpts = {
      platform: 'win32', schtasks: task.runner, unitDirs: [{ dir, scope: 'user' }],
      stopDaemon: async home => { expect(home).toBe(m.legacyHome); task.exit(); return 'stopped'; },
    };
    expect((await m.run(['--dry-run'], options)).ok).toBe(true);
    expect(task.calls).toEqual([]);
    expect(fs.existsSync(task.file)).toBe(true);
    expect((await m.run([], options)).ok).toBe(true);
    expect(m.done.slice().sort()).toEqual(m.planned.at(-1)!.slice().sort());
    expect(fs.existsSync(task.file)).toBe(false);
    expect(backupsOf(task.file)).toHaveLength(1);
    expect(fs.readFileSync(backupsOf(task.file)[0], 'utf8')).toBe(task.script);
    expect(backupsOf(path.join(m.legacyHome, 'claims', 'symbiont-config.json'))).toHaveLength(1);
    const [folder] = fs.readdirSync(path.join(m.mycoHome, 'backups'));
    const backupDir = path.join(m.mycoHome, 'backups', folder);
    const manifest = readJson(path.join(backupDir, 'manifest.json')).entries as Array<{ task?: string; backup: string }>;
    const snapshot = manifest.find(entry => entry.task === task.label)!;
    expect(fs.readFileSync(snapshot.backup, 'utf8')).toBe(task.xml);
    const recipe = fs.readFileSync(path.join(backupDir, 'restore.md'), 'utf8');
    expect(recipe).toContain('Copy-Item -LiteralPath');
    expect(recipe).toContain(`Register-ScheduledTask -TaskName '${task.label}'`);
    expect(recipe).toContain(snapshot.backup);
    expect(recipe).toContain('-Raw -Encoding UTF8');
  });

  it('writes PowerShell recovery for Windows claims even without a scheduled task', async () => {
    expect((await m.run([], { platform: 'win32', unitDirs: [], stopDaemon: async () => 'none' })).ok).toBe(true);
    const [folder] = fs.readdirSync(path.join(m.mycoHome, 'backups'));
    const recipe = fs.readFileSync(path.join(m.mycoHome, 'backups', folder, 'restore.md'), 'utf8');
    expect(recipe).toContain('```powershell');
    expect(recipe).toContain('Copy-Item -LiteralPath');
    expect(recipe).not.toContain('Register-ScheduledTask');
  });

  it('keeps the Windows definition and explains recovery when its daemon does not drain', async () => {
    const dir = path.join(m.home, 'windows-units');
    const task = legacyWindowsUnit(dir, m.legacyHome);
    const result = await m.run([], {
      platform: 'win32', schtasks: task.runner, unitDirs: [{ dir, scope: 'user' }],
      stopDaemon: async () => 'none',
    });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('Recovery instructions:');
    expect(task.calls.some(args => args[0] === '/delete')).toBe(false);
    expect(fs.readFileSync(task.file, 'utf8')).toBe(task.script);
    const [folder] = fs.readdirSync(path.join(m.mycoHome, 'backups'));
    const backupDir = path.join(m.mycoHome, 'backups', folder);
    const entries = readJson(path.join(backupDir, 'manifest.json')).entries as Array<{ task?: string; backup: string }>;
    expect(fs.readFileSync(entries.find(entry => entry.task === task.label)!.backup, 'utf8')).toBe(task.xml);
    expect(fs.readFileSync(path.join(backupDir, 'restore.md'), 'utf8')).toContain('Register-ScheduledTask');
  });

  it('restores the enabled task definition after two failed Windows cutovers', async () => {
    const dir = path.join(m.home, 'windows-units');
    const task = legacyWindowsUnit(dir, m.legacyHome);
    new CutoverBackup(cutoverBackupDir(m.mycoHome, '2000-01-01'), 'cutover', 'win32')
      .scheduledTask(task.label, task.xml.replace('<Task>', '<Task><Description>obsolete task</Description>'));
    const options: RunOpts = {
      platform: 'win32', schtasks: task.runner, unitDirs: [{ dir, scope: 'user' }],
      stopDaemon: async () => 'not-this-home',
    };
    const first = await m.run([], options);
    expect(first.ok).toBe(false);
    const firstRecipe = first.err.find(line => line.includes('Recovery instructions: '))!.trim().slice('Recovery instructions: '.length);
    const firstEntries = readJson(path.join(path.dirname(firstRecipe), 'manifest.json')).entries as Array<{ task?: string; backup: string }>;
    const original = firstEntries.find(entry => entry.task === task.label)!;
    expect(fs.readFileSync(original.backup, 'utf8')).toContain('<Enabled>true</Enabled>');
    expect(await task.runner.queryState(task.label)).toBe('disabled');

    const second = await m.run([], options);
    expect(second.ok).toBe(false);
    const secondRecipe = second.err.find(line => line.includes('Recovery instructions: '))!.trim().slice('Recovery instructions: '.length);
    expect(secondRecipe).not.toBe(firstRecipe);
    const entries = readJson(path.join(path.dirname(secondRecipe), 'manifest.json')).entries as Array<{ task?: string; backup: string }>;
    const snapshot = entries.find(entry => entry.task === task.label)!;
    expect(fs.readFileSync(snapshot.backup, 'utf8')).toBe(task.xml);
    expect(fs.readFileSync(secondRecipe, 'utf8')).toContain(original.backup);
    expect(fs.existsSync(task.file)).toBe(true);
    expect(task.calls.some(args => args[0] === '/delete')).toBe(false);
  });

  it('refuses a 1.4 unit that starts at boot rather than stopping it as a user unit', async () => {
    const boot = path.join(m.home, 'LaunchDaemons');
    fs.mkdirSync(boot, { recursive: true });
    fs.renameSync(path.join(m.agentsDir, `${DAEMON_LABEL}.plist`), path.join(boot, `${DAEMON_LABEL}.plist`));
    const result = await m.run([], { unitDirs: [{ dir: m.agentsDir, scope: 'user' }, { dir: boot, scope: 'boot' }] });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain(`${path.join(boot, `${DAEMON_LABEL}.plist`)} starts ${m.legacyHome}'s 1.4 daemon at boot`);
    expect(m.launchctl.calls).toEqual([]);
    expect(fs.existsSync(path.join(boot, `${DAEMON_LABEL}.plist`))).toBe(true);
  });

  it('refuses a member MCP entry of another Deployment before its first change', async () => {
    const otherHome = path.join(m.home, 'other-member');
    fs.mkdirSync(otherHome);
    const other = path.join(otherHome, 'bin', 'myco');
    writeJson(path.join(m.home, '.claude.json'), { mcpServers: { myco: { type: 'http', url: 'https://other.invalid/mcp', headersHelper: `${other} member mcp-headers ${CREDENTIAL_FLAG} registry --server https://other.invalid` } } });
    const unchanged = untouched();
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.ok).toBe(false);
      expect(result.err.join('\n')).toContain("Claude Code's Myco tools point at https://other.invalid; this machine is no longer connected there. Run `myco login https://other.invalid`, or remove `mcpServers.myco` in `~/.claude.json` and run `myco member provision --refresh`.");
      expect(result.err.join('\n')).not.toContain('myco doctor');
      expect(result.err.join('\n')).toContain('Nothing was changed.');
      unchanged();
    }
  });

  it('refuses when every vault session was captured on another machine, and warns when some were', async () => {
    const db = new Database(m.vault);
    db.run(`UPDATE sessions SET machine_id = 'old_machine_1234'`);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const unchanged = untouched();
    const refused = await m.run(['--dry-run']);
    expect(refused.ok).toBe(false);
    expect(refused.err.join('\n')).toContain(`every session in the 1.4 vaults was captured under another machine id (old_machine_1234: 1), not this machine's (${TEST_MACHINE_ID})`);
    unchanged();

    const again = new Database(m.vault);
    again.run('PRAGMA foreign_keys = OFF');
    again.run(`INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, machine_id, created_at) VALUES (?, 'claude-code', ?, ?, ?, ?, 'completed', ?, ?)`,
      ['00000000-0000-4000-8000-000000000009', m.root, PROJECT, NOW_S - 86_400 * 30, NOW_S - 86_400 * 30 + 60, TEST_MACHINE_ID, NOW_S - 86_400 * 30]);
    again.run('PRAGMA wal_checkpoint(TRUNCATE)');
    again.close();
    const warned = await m.run(['--dry-run']);
    expect(warned.ok).toBe(true);
    expect(warned.out.join('\n')).toContain(`warning: the 1.4 vaults record 1 sessions under old_machine_1234, not this machine's id (${TEST_MACHINE_ID})`);
  });

  it('refuses a daemon unit it cannot attribute to a home', async () => {
    fs.writeFileSync(path.join(m.agentsDir, 'co.goondocks.myco.anon.plist'), plist('co.goondocks.myco.anon', ['/opt/myco/bin/myco', 'daemon'], {}));
    const unchanged = untouched();
    const result = await m.run();
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('co.goondocks.myco.anon.plist runs `myco daemon` but names no home');
    unchanged();
  });

  it('imports nothing when a vault could not be copied', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'backups'), 'not a directory');
    const result = await m.run();
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('not every vault has a verified copy; nothing was imported');
    expect(m.rig.rows('spores')).toBe(0);
    expect(m.rig.rows('sessions')).toBe(0);
    expect(result.out.join('\n')).not.toContain('Cutover complete.');
  });

  it('takes a new copy of a vault that changed since the last run, and imports from it', async () => {
    expect((await m.run()).ok).toBe(true);
    const db = new Database(m.vault);
    db.run(`UPDATE spores SET content = 'changed in 1.4' WHERE id = 'gotcha-1'`);
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const again = await m.run();
    expect(again.ok).toBe(true);
    expect(again.out.join('\n')).toContain('the vault changed since the earlier copy');
    const copies = fs.readdirSync(path.join(m.legacyHome, 'backups')).sort();
    expect(copies.length).toBe(2);
    const latest = new Database(path.join(m.legacyHome, 'backups', copies[1], 'grove_a', 'myco.db'));
    expect(latest.query(`SELECT content FROM spores`).all()).toEqual([{ content: 'changed in 1.4' }]);
    latest.close();
  });

  it('takes a new copy when the one recorded no longer holds what the vault holds', async () => {
    expect((await m.run()).ok).toBe(true);
    const [first] = fs.readdirSync(path.join(m.legacyHome, 'backups'));
    const copy = new Database(path.join(m.legacyHome, 'backups', first, 'grove_a', 'myco.db'));
    copy.run(`UPDATE spores SET content = 'altered in the copy' WHERE id = 'gotcha-1'`);
    copy.run('PRAGMA wal_checkpoint(TRUNCATE)');
    copy.close();
    const again = await m.run();
    expect(again.ok).toBe(true);
    expect(again.out.join('\n')).not.toContain('copied earlier');
    expect(fs.readdirSync(path.join(m.legacyHome, 'backups')).length).toBe(2);
  });

  it('fails the run when the Deployment refuses a write', async () => {
    const refusing: MemberRig['fetch'] = async (input, init) =>
      String(input).endsWith('/spores/save') ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) : m.rig.fetch(input, init);
    const result = await m.run([], { fetch: refusing });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('the Deployment refused or failed part of the 1.4 history');
    expect(result.out.join('\n')).not.toContain('Cutover complete.');
  });

  it('leaves the 1.4 service and its claim alone, and imports nothing, when an agent could not be pointed at 2.0', async () => {
    const result = await m.run([], { provision: () => ({ kind: 'refused', detail: 'the agent\'s settings could not be written' }) });
    expect(result.ok).toBe(false);
    expect(result.err.join('\n')).toContain('The 1.4 service is left running');
    expect(bootouts()).toEqual([]);
    expect(fs.existsSync(path.join(m.agentsDir, `${DAEMON_LABEL}.plist`))).toBe(true);
    expect(claimOwner(m.legacyHome)).toBe(m.legacyHome);
    expect(fs.existsSync(path.join(m.legacyHome, 'backups'))).toBe(false);
    expect(m.rig.rows('spores')).toBe(0);
  });

  for (const interrupted of [false, true]) it(`reports why the transcript import ${interrupted ? 'was interrupted' : 'was refused'}`, async () => {
    const controller = new AbortController();
    const id = '00000000-0000-4000-8000-000000000002';
    const transcript = path.join(m.home, '.claude', 'projects', `-${rootSlug(m.root)}`, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: m.root, sessionId: id, message: { content: `after 1.4 ${'x'.repeat(5000)}` }, timestamp: '2026-08-01T10:00:00Z' })}\n`);
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(transcript, old, old);
    const refusing: MemberRig['fetch'] = async (input, init) => {
      const transcriptPlan = String(input).endsWith('/import/plan') && !String(init?.body ?? '').includes('"sessions"');
      if (transcriptPlan && interrupted) { controller.abort(); throw new DOMException('stopped', 'AbortError'); }
      return transcriptPlan ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) : m.rig.fetch(input, init);
    };
    const result = await m.run([], { fetch: refusing, signal: controller.signal });
    expect(result.ok).toBe(false);
    if (interrupted) {
      expect(result.out.some((line) => line.startsWith('9.'))).toBe(false);
      expect(result.out.join('\n')).toMatch(/stoppedBy:.*you stopped the import; run the same command again to resume safely/);
    }
    expect(result.err.join('\n')).toMatch(/the transcript import stopped before it finished \(proj_1: [^)]+\)/);
  });

  /** Everything the cutover would change, byte for byte, to show a refused run changed none of it. */
  const untouched = () => {
    const files = [settingsFile(), path.join(m.home, '.claude.json'), path.join(m.legacyHome, 'claims', 'symbiont-config.json')];
    const bytes = Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const units = fs.readdirSync(m.agentsDir).sort();
    const events = m.rig.rows('events');
    return () => {
      expect(Object.fromEntries(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))).toEqual(bytes);
      expect(listRegistryEntries(m.mycoHome)).toEqual([]);
      expect(fs.existsSync(path.join(m.legacyHome, 'backups'))).toBe(false);
      expect(fs.existsSync(path.join(m.mycoHome, 'backups'))).toBe(false);
      expect(fs.readdirSync(m.agentsDir).sort()).toEqual(units);
      expect(m.launchctl.calls).toEqual([]);
      expect(m.rig.rows('events')).toBe(events);
    };
  };

  it('keeps a stale hook beside live member capture and the users hook', async () => {
    const file = path.join(m.home, '.claude', 'settings.json');
    const settings = readJson(file);
    const binary = path.join(m.home, 'deleted-install', 'bin', 'myco');
    const stale = { hooks: [{ command: `${binary} hook stop --myco-managed`, timeout: 3 }] };
    (settings.hooks as Record<string, unknown[]>).Stop.push(stale);
    writeJson(file, settings);
    const dry = await m.run(['--dry-run']);
    expect(dry.ok).toBe(true);
    expect(dry.out.join('\n')).toContain("would set up Claude Code's hooks, tools, skills");
    const real = await m.run();
    expect(real.ok).toBe(true);
    const commands = hookCommands(readJson(file).hooks);
    expect(commands.some(command => command.includes('--credential registry'))).toBe(true);
    expect(commands).toContain('echo mine');
    expect(commands).toContain(stale.hooks[0].command);
    expect(JSON.stringify((readJson(file).hooks as Record<string, unknown[]>).Stop.find(group => JSON.stringify(group) === JSON.stringify(stale)))).toBe(JSON.stringify(stale));
    expect(commands.some(command => command.startsWith(path.join(m.legacyHome, 'bin', 'myco')))).toBe(false);
  });

  it('names only the blocked plugin surface when an agent has no MCP target', async () => {
    const file = path.join(m.home, '.pi', 'agent', 'extensions', 'myco', 'index.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const before = `// myco:plugin-marker\nconst binary = "${m.home}/deleted-install/bin/myco";\n`;
    fs.writeFileSync(file, before);
    const dry = await m.run(['--dry-run'], { agents: ['claude-code', 'pi'] });
    expect(dry.ok).toBe(true);
    expect(dry.out.join('\n')).toContain('capture hooks are not set up because stale entries occupy their place');
    expect(dry.out.join('\n')).not.toContain('capture hooks and tools are not set up');
    expect((await m.run([], { agents: ['claude-code', 'pi'] })).ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('names the skipped tools surface in preview while setting up capture beside it', async () => {
    const file = path.join(m.home, '.claude.json');
    const entry = { command: `${m.home}/deleted-install/bin/myco` };
    writeJson(file, { mcpServers: { myco: entry } });
    const dry = await m.run(['--dry-run']);
    expect(dry.ok).toBe(true);
    const action = dry.out.find(line => line.includes("would set up Claude Code's"));
    expect(action).toContain("hooks, skills");
    expect(action).toContain('tools are not set up because stale entries occupy their place');
    const real = await m.run();
    expect(real.ok).toBe(true);
    expect(real.out.map(line => line.trim())).toContain('provisioned Claude Code globally (hooks, skills, settings)');
    expect(real.out.join('\n')).not.toContain('(hooks and MCP)');
    expect(readJson(file).mcpServers).toEqual({ myco: entry });
    expect(hookCommands(readJson(settingsFile()).hooks).some(command => command.includes('--credential registry'))).toBe(true);
    for (const result of [dry, real]) expect(result.out.filter(line => line.includes(`stale Myco entry in ${file}`))).toHaveLength(1);
  });

  it('reports each repeated stale hook entry while preserving both groups', async () => {
    const file = settingsFile();
    const settings = readJson(file);
    const stale = { hooks: [{ command: `${m.home}/deleted-install/bin/myco hook stop --myco-managed` }] };
    (settings.hooks as Record<string, unknown[]>).Stop.push(stale, structuredClone(stale));
    writeJson(file, settings);
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.ok).toBe(true);
      expect(result.out.filter(line => line.includes(`stale Myco entry in ${file}:`))).toHaveLength(2);
      expect((readJson(file).hooks as Record<string, unknown[]>).Stop.filter(group => JSON.stringify(group) === JSON.stringify(stale))).toHaveLength(2);
    }
  });

  it('removes and backs up top-level Claude 1.4 tools when Claude is not provisioned', async () => {
    const file = path.join(m.home, '.claude.json');
    const before = fs.readFileSync(file);
    const dry = await m.run(['--dry-run'], { agents: ['codex'] });
    expect(dry.ok).toBe(true);
    expect(dry.out.join('\n')).toContain(`would remove the \`myco\` MCP entry from ${file}`);
    expect(fs.readFileSync(file)).toEqual(before);
    expect((await m.run([], { agents: ['codex'] })).ok).toBe(true);
    expect((readJson(file).mcpServers as Record<string, unknown> | undefined)?.myco).toBeUndefined();
    expect(backupsOf(file)).toHaveLength(1);
  });

  it.skipIf(!process.env.MYCO_CUTOVER_TEST_BINARY)('preserves a stale entry through the compiled cutover command against a fake Deployment', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => m.rig.fetch(request) });
    const serverUrl = `http://127.0.0.1:${server.port}`;
    const mycoHome = tempMycoHome();
    writeDeploymentMembership({ serverUrl, token: m.rig.token, tokenId: m.rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: 1, updatedAt: 1 }, { mycoHome });
    const file = path.join(m.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    const binary = path.join(m.home, 'deleted-install', 'bin', 'myco');
    writeJson(file, { servers: { myco: { command: binary, args: ['mcp'] } } });
    const before = fs.readFileSync(file);
    const hooksFile = path.join(m.home, '.claude', 'settings.json');
    const settings = readJson(hooksFile);
    const staleHook = { hooks: [{ command: `${binary} hook stop --myco-managed` }] };
    (settings.hooks as Record<string, unknown[]>).Stop.push(staleHook);
    writeJson(hooksFile, settings);
    const unitDir = path.join(m.home, 'empty-units');
    const bin = path.join(m.home, 'bin');
    fs.mkdirSync(unitDir);
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(m.home, 'tmp'));
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      for (const args of [['--dry-run'], []]) {
        const child = Bun.spawn([process.env.MYCO_CUTOVER_TEST_BINARY!, 'cutover', '--server', serverUrl, '--legacy-home', m.legacyHome, ...args], {
          cwd: m.home, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: m.home, CODEX_HOME: path.join(m.home, '.codex'),
            CLAUDE_CONFIG_DIR: path.join(m.home, '.claude'), XDG_CONFIG_HOME: path.join(m.home, '.config'), MYCO_HOME: mycoHome,
            TMPDIR: path.join(m.home, 'tmp'), MYCO_LAUNCH_AGENTS_DIR: unitDir, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        });
        const timeout = setTimeout(() => child.kill(), 20_000);
        try {
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
          expect(stdout).toContain(`stale Myco entry in ${file}: the top-level "myco" MCP server; binary ${binary} is missing.`);
          expect(fs.readFileSync(file)).toEqual(before);
          expect((readJson(hooksFile).hooks as Record<string, unknown[]>).Stop).toContainEqual(staleHook);
          if (args.length === 0) {
            expect(hookCommands(readJson(hooksFile).hooks).some(command => command.includes('--credential registry'))).toBe(true);
            expect(hookCommands(readJson(hooksFile).hooks)).toContain('echo mine');
          }
        } finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill(); await child.exited; } }
      }
      expect(m.rig.rows('sessions')).toBeGreaterThan(0);
    } finally { await server.stop(true); }
  });

  for (const location of [...LEGACY_REGISTRATIONS.filter((location) => ['mcp', 'hooks', 'plugin-file'].includes(location.kind)), CLAUDE_PROJECT_MCP]) {
    it(`leaves a stale ${location.agent} ${location.scope} ${location.path} ${location.kind} unchanged through preview and cutover`, async () => {
      const binary = path.join(m.home, 'deleted-install', 'bin', 'myco');
      const file = location.scope === 'project' ? path.join(m.root, location.path) : path.join(m.home, location.path.replace(/^~\//, ''));
      const command = `${binary} hook stop --symbiont ${location.agent} --myco-managed`;
      if (location.kind === 'mcp') {
        if (location.format === 'toml') {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `[mcp_servers.myco]\ncommand = ${JSON.stringify(binary)}\nargs = ["mcp"]\n`);
        } else {
          const entry = { command: location.agent === 'opencode' ? [binary, 'mcp'] : binary, args: ['mcp'] };
          writeJson(file, location === CLAUDE_PROJECT_MCP ? { projects: { [m.root]: { mcpServers: { myco: entry } } } } : { [location.serversKey!]: { myco: entry } });
        }
      } else if (location.kind === 'hooks' || location.path.endsWith('.json')) {
        writeJson(file, { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `// myco:plugin-marker\nconst bin = ${JSON.stringify(binary)};\n`);
      }
      const before = fs.readFileSync(file);
      const preserved = () => scanLegacyRegistrations({ homeDir: m.home, folders: [m.root], legacyHomes: [m.legacyHome], ownHome: m.mycoHome, allClaudeProjects: true }).findings.filter(finding => finding.file === file && finding.verdict === 'stale').map(finding => finding.subject);
      const entries = preserved();
      for (const args of [['--dry-run'], []]) {
        const result = await m.run(args, { agents: [...new Set(['claude-code', location.agent])] });
        expect(result.err).toEqual([]);
        expect(result.ok).toBe(true);
        const stale = result.out.filter((line) => line.includes(`stale Myco entry in ${file}:`));
        expect(stale).toHaveLength(1);
        expect(stale[0]).toContain(`binary ${binary} is missing. Myco leaves this entry alone;`);
        expect(stale[0]).toContain(location.agent === 'claude-code' ? 'Claude Code' : location.agent === 'copilot' ? 'GitHub Copilot' : '');
        expect(stale[0]).toContain("You may delete it");
        expect(preserved()).toEqual(entries);
        if (args.length > 0) expect(fs.readFileSync(file)).toEqual(before);
      }
    });
  }

  for (const kind of ['hooks', 'mcp']) it(`preserves stale ${kind} in a linked global config`, async () => {
    const file = kind === 'hooks' ? settingsFile() : path.join(m.home, '.claude.json');
    const target = path.join(m.home, 'dotfiles', `${kind}.json`);
    const binary = path.join(m.home, 'deleted-install', 'bin', 'myco');
    writeJson(target, kind === 'hooks' ? { hooks: { Stop: [{ hooks: [{ command: `${binary} hook stop --myco-managed` }] }] } }
      : { mcpServers: { myco: { command: binary, args: ['mcp'] } } });
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
    const before = fs.readFileSync(target);
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.err).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.out.join('\n')).toContain(`stale Myco entry in ${file}`);
      if (kind === 'mcp') expect(result.out.join('\n')).toContain('tools are not set up because this entry occupies their place');
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      if (kind === 'mcp' || args.length > 0) expect(fs.readFileSync(target)).toEqual(before);
      else expect(hookCommands(readJson(target).hooks)).toContain(`${binary} hook stop --myco-managed`);
    }
  });

  it('lists a stale Claude project entry outside the migration roots while preserving its entry and unrelated legacy entries', async () => {
    const file = path.join(m.home, '.claude.json');
    const folder = path.join(m.home, 'unrelated-project');
    const binary = path.join(m.home, 'deleted-install', 'bin', 'myco');
    writeJson(file, { projects: {
      [folder]: { mcpServers: { myco: { command: binary, args: ['mcp'] } } },
      [path.join(m.home, 'unrelated-legacy')]: { mcpServers: { myco: { command: `${m.legacyHome}/bin/myco`, args: ['mcp'] } } },
    } });
    const before = readJson(file).projects;
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.err).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.out.filter(line => line.includes(`stale Myco entry in ${file}: the "myco" MCP server for project ${folder};`))).toHaveLength(1);
      if (args.length > 0) {
        expect(result.out.join('\n')).toContain(`would set up Claude Code's hooks, tools, skills for ${m.mycoHome}`);
        expect(result.out.join('\n')).not.toContain(`would point Claude Code at ${m.mycoHome}`);
      }
      expect(readJson(file).projects).toEqual(before);
    }
  });

  for (const [agent, fileName, helperKey, serversKey] of [
    ['claude-code', '.claude.json', 'headersHelper', 'mcpServers'],
    ['codex', '.codex/config.toml', 'http_headers_helper', 'mcp_servers'],
  ]) it(`leaves ${agent}'s stale remote tools helper alone without naming another Deployment`, async () => {
    const file = path.join(m.home, fileName);
    const binary = path.join(m.home, 'deleted-member', 'bin', 'myco');
    const helper = `${binary} member mcp-headers --credential registry --server https://other.invalid`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (agent === 'codex') fs.writeFileSync(file, `[mcp_servers.myco]\nurl = "https://other.invalid/mcp"\n${helperKey} = ${JSON.stringify(helper)}\n`);
    else writeJson(file, { mcpServers: { myco: { type: 'http', url: 'https://other.invalid/mcp', [helperKey]: helper } } });
    const before = fs.readFileSync(file);
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args, { agents: ['claude-code', agent] });
      expect(result.err).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.out.join('\n')).toContain(`stale Myco entry in ${file}: ${agent === 'codex' ? 'the Myco tools entry' : 'the top-level "myco" MCP server'}; binary ${binary} is missing.`);
      expect(result.out.join('\n')).not.toMatch(/held elsewhere|point at https:\/\/other.invalid/);
      if (args.length > 0 || agent !== 'codex') expect(fs.readFileSync(file)).toEqual(before);
      else expect(parseToml(fs.readFileSync(file, 'utf8'))[serversKey]).toEqual(parseToml(before.toString())[serversKey]);
    }
  });

  for (const state of ['home-present', 'binary-present', 'bare'] as const) {
    it(`keeps the existing foreign MCP refusal for ${state}`, async () => {
      const other = path.join(m.home, 'other-install');
      if (state !== 'bare') fs.mkdirSync(other);
      const binary = state === 'bare' ? 'myco' : path.join(other, 'bin', 'myco');
      if (state === 'binary-present') { fs.mkdirSync(path.dirname(binary)); fs.writeFileSync(binary, 'fixture'); }
      const file = path.join(m.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
      writeJson(file, { servers: { myco: { command: binary, env: { MYCO_HOME: other } } } });
      const before = fs.readFileSync(file);
      for (const args of [['--dry-run'], []]) {
        const result = await m.run(args);
        expect(result.ok).toBe(false);
        expect(result.err.join('\n')).toContain(`${file} holds a Myco MCP entry of another installation`);
        expect(result.err.join('\n')).toContain('--legacy-home');
        expect(fs.readFileSync(file)).toEqual(before);
      }
    });
  }

  it('stops before its first change when another installation holds the agents\' settings, and names the flag', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'claims', 'symbiont-config.json'), JSON.stringify({ subsystem: 'symbiont-config', owner: '/elsewhere/.myco-other', pid: 1, claimed_at: 1 }));
    const unchanged = untouched();
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.ok).toBe(false);
      expect(result.err.join('\n')).toContain('/elsewhere/.myco-other holds your agents\' settings');
      expect(result.err.join('\n')).toContain('add `--legacy-home /elsewhere/.myco-other`');
      expect(result.err.join('\n')).toContain('Nothing was changed.');
      unchanged();
    }
  });

  it('stops before its first change when this machine is pinned to another home', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'runtime.home'), '/elsewhere/member-home\n');
    const unchanged = untouched();
    for (const args of [['--dry-run'], []]) {
      const result = await m.run(args);
      expect(result.ok).toBe(false);
      expect(result.err.join('\n')).toContain('this machine is pinned to /elsewhere/member-home');
      unchanged();
    }
  });

  it('stops before its first change when another home\'s hooks are in the agents\' settings, and names them and the flag', async () => {
    const otherHome = path.join(m.home, 'other-install');
    fs.mkdirSync(otherHome);
    const other = path.join(otherHome, 'bin', 'myco');
    const legacyBin = path.join(m.legacyHome, 'bin', 'myco');
    for (const foreign of [`${other} hook stop --symbiont claude-code --myco-managed`, `MYCO_HOME=/elsewhere/member-home ${legacyBin} hook stop --symbiont claude-code --myco-managed`]) {
      writeJson(settingsFile(), { hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } });
      const unchanged = untouched();
      for (const args of [['--dry-run'], []]) {
        const result = await m.run(args);
        expect(result.ok).toBe(false);
        expect(result.err.join('\n')).toContain(`belong to another installation (\`${foreign}\`)`);
        expect(result.err.join('\n')).toContain('--legacy-home');
        unchanged();
      }
    }
  });

  it('cuts over into the home the machine pin names, and says so first, when the 1.4 hooks run through that pin', async () => {
    fs.writeFileSync(path.join(m.legacyHome, 'runtime.home'), `${m.mycoHome}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: m.home, MYCO_LAUNCH_AGENTS_DIR: m.agentsDir };
    delete env.MYCO_HOME;
    const unchanged = untouched();
    const dry = await m.run(['--dry-run'], { mycoHome: null, env });
    expect(dry.err).toEqual([]);
    expect(dry.ok).toBe(true);
    const said = dry.out.join('\n');
    expect(said).toContain(`into ${m.mycoHome} (chosen by the machine pin ${path.join(m.legacyHome, 'runtime.home')})`);
    expect(said).toContain(`would set up Claude Code's hooks, tools, skills for ${m.mycoHome}, replacing the 1.4 registrations of ${m.legacyHome}`);
    unchanged();

    const real = await m.run([], { mycoHome: null, env });
    expect(real.err).toEqual([]);
    expect(real.ok).toBe(true);
    expect(listRegistryEntries(m.mycoHome).map((e) => e.root)).toEqual([m.root]);
    expect(hookCommands(readJson(settingsFile()).hooks).filter((c) => c.includes('hook ')).every((c) => c.includes(CREDENTIAL_FLAG))).toBe(true);
  });
});

describe('myco cutover on two 1.4 homes, one pinned as the 2.0 home (the owner\'s layout)', () => {
  it('stops the pinned home\'s daemon, points both homes\' claims at it, and takes 1.4 out of every agent', async () => {
    const m = await machine({ legacyHome: '.myco-dev' });
    const heldHome = process.env.HOME;
    process.env.HOME = m.home;
    try {
      // ~/.myco is a 1.4 home too: a vault of its own, its claim, and the pin to ~/.myco-dev.
      const prod = path.join(m.home, '.myco');
      const prodVault = path.join(prod, 'groves', 'grove_p', 'myco.db');
      fs.mkdirSync(path.dirname(prodVault), { recursive: true });
      const db = new Database(prodVault);
      db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
      db.run('PRAGMA foreign_keys = OFF');
      db.run(`INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at) VALUES ('prod-1', ?, 'user', 'gotcha', 'active', 'from ~/.myco', ?)`, [PROJECT, NOW_S]);
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      fs.renameSync(path.join(m.legacyHome, 'claims'), path.join(prod, 'claims'));
      fs.writeFileSync(path.join(prod, 'claims', 'symbiont-config.json'), JSON.stringify({ subsystem: 'symbiont-config', owner: prod, pid: 1, claimed_at: 1 }));
      fs.writeFileSync(path.join(prod, 'runtime.home'), `${m.legacyHome}\n`);
      // The member lives in the pinned home.
      writeDeploymentMembership({ serverUrl: SERVER, token: m.rig.token, tokenId: m.rig.tokenId, machineId: TEST_MACHINE_ID, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome: m.legacyHome });
      const devBin = path.join(m.legacyHome, 'bin', 'myco');
      const copilotMcp = path.join(m.home, '.copilot', 'mcp-config.json');
      writeJson(copilotMcp, { mcpServers: { myco: { type: 'stdio', command: devBin, args: ['mcp'] } } });
      writeJson(settingsFile(), { ...readJson(settingsFile()), mcpServers: { myco: { type: 'stdio', command: devBin, args: ['mcp'] } } });

      const env: NodeJS.ProcessEnv = { ...process.env, HOME: m.home, MYCO_LAUNCH_AGENTS_DIR: m.agentsDir };
      delete env.MYCO_HOME;
      const args = ['--legacy-home', prod, '--legacy-home', m.legacyHome, '--route', `${PROJECT}=${SERVER}`];
      const dry = await m.run([...args, '--dry-run'], { mycoHome: null, env });
      expect(dry.err).toEqual([]);
      expect(dry.ok).toBe(true);
      const result = await m.run(args, { mycoHome: null, env });
      expect(result.err).toEqual([]);
      expect(result.ok).toBe(true);
      expect(m.done).toEqual(m.planned[0]);

      expect(bootouts()).toEqual([DAEMON_LABEL]);
      expect(fs.existsSync(path.join(m.agentsDir, `${DAEMON_LABEL}.plist`))).toBe(false);
      expect(claimOwner(prod)).toBe(m.legacyHome);
      expect(claimOwner(m.legacyHome)).toBe(m.legacyHome);
      expect(readJson(copilotMcp).mcpServers).toEqual({});
      expect(readJson(settingsFile()).mcpServers).toEqual({});
      expect(hookCommands(readJson(settingsFile()).hooks).filter((c) => c.includes('hook ')).every((c) => c.includes(CREDENTIAL_FLAG))).toBe(true);
      expect(m.rig.env.sqlite.query(`SELECT id FROM spores ORDER BY id`).all()).toEqual([{ id: 'gotcha-1' }, { id: 'prod-1' }]);
    } finally {
      if (heldHome === undefined) delete process.env.HOME; else process.env.HOME = heldHome;
    }

    function settingsFile() { return path.join(m.home, '.claude', 'settings.json'); }
    function claimOwner(claimsHome: string) { return (readJson(path.join(claimsHome, 'claims', 'symbiont-config.json')) as { owner: string }).owner; }
    function bootouts() { return m.launchctl.calls.filter((c) => c[0] === 'bootout').map((c) => c[c.length - 1].split('/').pop()); }
  });
});

describe('asking a home\'s daemon to exit', () => {
  it('asks only the daemon whose pid the home records, on the port the home records', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-daemon-home-'));
    const statePath = resolveServiceDaemonStatePath(home);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: 111, port: 45_678 }));
    const asked: string[] = [];
    const answering = (pid: number): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/shutdown')) { pid = -1; return new Response('', { status: 202 }); }
      if (pid < 0) throw new Error('gone');
      return Response.json({ myco: true, pid });
    }) as typeof fetch;
    expect(await stopHomeDaemon(home, answering(222))).toBe('not-this-home');
    expect(asked.some((a) => a.startsWith('POST'))).toBe(false);
    expect(asked[0]).toBe('GET http://127.0.0.1:45678/health');
    asked.length = 0;
    expect(await stopHomeDaemon(home, answering(111))).toBe('stopped');
    expect(asked).toContain('POST http://127.0.0.1:45678/api/shutdown');
  });
});

describe('the `myco cutover` command', () => {
  it('exits non-zero when the cutover does not complete', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cutover-cli-'));
    const cli = path.join(resolvePackageRoot(), 'src', 'cli.ts');
    const env = { ...process.env, HOME: home, MYCO_HOME: path.join(home, '.myco') };
    const refused = spawnSync(process.execPath, [cli, 'cutover', '--dry-run'], { env, cwd: home, encoding: 'utf8', timeout: 60_000 });
    expect(refused.stderr).toContain('myco cutover: this machine is not signed in to a Deployment');
    expect(refused.status).toBe(2);
    const help = spawnSync(process.execPath, [cli, 'cutover', '--help'], { env, cwd: home, encoding: 'utf8', timeout: 60_000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--dismiss-earlier-copies');
  });
});
