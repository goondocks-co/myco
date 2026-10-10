import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { assertTestPath, sandboxChildEnv } from '../../../scripts/test-environment.mjs';

const LEGACY_SCHEMA = fs.readFileSync(new URL('../../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8');
const LEGACY_SECONDS = 1_700_000_000;
export const LEGACY_PROJECT_IDS = ['proj_legacy_a', 'proj_legacy_b'] as const;

/** A file-only 1.4 home with retained history, owned integrations and unit files. No runnable 1.x binary. */
export function legacyFixtureHome(root: string, options: { skippedProject?: boolean } = {}) {
  assertTestPath(process.env.MYCO_TEST_RUN_ROOT!, root, 'legacy fixture');
  const home = path.join(root, 'user');
  const mycoHome = path.join(home, '.myco');
  const vault = path.join(mycoHome, 'groves', 'grove_fixture', 'myco.db');
  const binary = path.join(mycoHome, 'bin', 'myco');
  const projectIds = [...LEGACY_PROJECT_IDS, ...(options.skippedProject ? ['proj_setup_skipped'] : [])];
  const projects = projectIds.map((id) => ({ id, root: path.join(home, 'Repos', id), sessionId: `legacy_session_${id}` }));
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode: 0o600 });
  };
  fs.mkdirSync(path.dirname(vault), { recursive: true });
  const db = new Database(vault);
  try {
    db.exec(LEGACY_SCHEMA);
    for (const project of projects) {
      fs.mkdirSync(project.root, { recursive: true });
      db.run("INSERT INTO sessions (id, agent, project_root, project_id, started_at, ended_at, status, title, created_at) VALUES (?, 'claude-code', ?, ?, ?, ?, 'completed', 'Retained legacy session', ?)",
        [project.sessionId, project.root, project.id, LEGACY_SECONDS, LEGACY_SECONDS + 60, LEGACY_SECONDS]);
      db.run("INSERT INTO prompt_batches (id, project_id, session_id, prompt_number, user_prompt, origin, started_at, created_at) VALUES (?, ?, ?, 1, 'Retained legacy prompt', 'human', ?, ?)",
        [projects.indexOf(project) + 1, project.id, project.sessionId, LEGACY_SECONDS, LEGACY_SECONDS]);
      db.run("INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at) VALUES (?, ?, 'user', 'gotcha', 'active', 'Retained legacy spore', ?)", [`spore_${project.id}`, project.id, LEGACY_SECONDS]);
    }
  } finally { db.close(); }
  write(binary, 'Fixture presence marker. Never execute a 1.x binary.\n');
  write(path.join(mycoHome, 'claims', 'symbiont-config.json'), JSON.stringify({ subsystem: 'symbiont-config', owner: mycoHome, pid: 1, claimed_at: 1 }));
  const hook = (event: string) => ({ hooks: [{ type: 'command', command: `${binary} hook ${event} --symbiont claude-code --myco-managed` }] });
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [hook('session-start')], Stop: [hook('stop')] }, userSetting: 'preserve' }));
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { myco: { command: binary, args: ['mcp'] }, unrelated: { command: 'user-tool' } } }));
  write(path.join(home, '.codex', 'config.toml'), `[mcp_servers.myco]\ncommand = "${binary}"\nargs = ["mcp"]\n`);
  const label = 'co.goondocks.myco';
  const agentsDir = path.join(home, 'Library', 'LaunchAgents');
  write(path.join(agentsDir, `${label}.plist`), `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${binary}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>MYCO_HOME</key><string>${mycoHome}</string></dict></dict></plist>`);
  write(path.join(home, '.config', 'systemd', 'user', 'myco.service'), `[Service]\nExecStart=${binary} daemon\nEnvironment=MYCO_HOME=${mycoHome}\n`);
  return { root, home, mycoHome, vault, binary, projects, agentsDir, env: sandboxChildEnv(root, { HOME: home, MYCO_HOME: mycoHome, MYCO_LAUNCH_AGENTS_DIR: agentsDir }) };
}
