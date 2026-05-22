/**
 * Migration-walker cleanup of pre-global-install project-local agent
 * configs.
 *
 * Surfaced by dogfood: prod-served projects (e.g. ten-second-tom) had
 * leftover project-local `.codex/hooks.json` + `.codex/config.toml`
 * from before the global migration. When the new global install wrote
 * `mcp_servers.myco` to `~/.codex/config.toml`, the project-local block
 * collided with the global one and Codex rejected the merge with
 * "url is not supported for stdio in `mcp_servers.myco`". Hooks
 * silently disabled for the affected projects.
 *
 * The walker is supposed to strip those leftover Myco-managed sections
 * during its periodic pass. This suite locks that contract so the
 * cleanup can't regress.
 *
 * The seed shape mirrors exactly what was found on disk:
 *
 *   .codex/hooks.json — all 5 codex hook event entries pointing at the
 *     retired project-local launcher (`node .agents/myco-run.cjs ...`).
 *   .codex/config.toml — `[mcp_servers.myco]` with stdio shape
 *     (`command = "myco-run", args = ["mcp"]`) plus a small
 *     `[features]` block. Both are pure Myco-installer output.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProjectLocalMigration } from '@myco/grove/migration-walker.js';
import {
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

let tmpMycoHome: string;
let tmpProjectsParent: string;

beforeEach(() => {
  tmpMycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-walker-codex-home-'));
  tmpProjectsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-walker-codex-projects-'));
  fs.mkdirSync(path.join(tmpMycoHome, 'groves'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpMycoHome, { recursive: true, force: true });
  fs.rmSync(tmpProjectsParent, { recursive: true, force: true });
});

/**
 * Plant the exact pre-migration codex artifacts found on a dogfood
 * project (ten-second-tom): a Myco-generated project-local hooks.json
 * and a config.toml with a stdio-shaped Myco MCP server stub.
 */
function seedPreMigrationCodexProject(name: string): string {
  const projectRoot = path.join(tmpProjectsParent, name);
  fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });

  // Real pre-migration shape — verbatim from a dogfood project's disk.
  fs.writeFileSync(path.join(projectRoot, '.codex', 'hooks.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{
        type: 'command',
        command: 'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && node .agents/myco-run.cjs hook session-start --symbiont codex',
        timeout: 10,
      }] }],
      UserPromptSubmit: [{ hooks: [{
        type: 'command',
        command: 'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && node .agents/myco-run.cjs hook user-prompt-submit --symbiont codex',
        timeout: 5,
      }] }],
      PostToolUse: [{ hooks: [{
        type: 'command',
        command: 'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && node .agents/myco-run.cjs hook post-tool-use --symbiont codex',
        timeout: 5,
      }] }],
      Stop: [{ hooks: [{
        type: 'command',
        command: 'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && node .agents/myco-run.cjs hook stop --symbiont codex',
        timeout: 30,
      }] }],
    },
  }, null, 2) + '\n', 'utf-8');

  fs.writeFileSync(path.join(projectRoot, '.codex', 'config.toml'),
    '[mcp_servers.myco]\n' +
    'command = "myco-run"\n' +
    'args = ["mcp"]\n' +
    'cwd = "."\n' +
    '\n' +
    '[features]\n' +
    'codex_hooks = true\n',
    'utf-8',
  );

  // Vault with no `symbionts:` opt-in — the walker treats this as a
  // legacy brownfield project, which is what every pre-migration
  // project looks like.
  fs.writeFileSync(path.join(projectRoot, '.myco', 'myco.yaml'),
    `# ${name}\nversion: 3\nconfig_version: 9\n`,
    'utf-8',
  );

  return projectRoot;
}

describe('migration walker — cleans up pre-global-install project-local .codex artifacts', () => {
  it('removes Myco-owned mcp_servers.myco block from project-local .codex/config.toml', () => {
    const grove = createGrove('default', tmpMycoHome, { servedBy: 'service-dev' });
    const projectRoot = seedPreMigrationCodexProject('legacy-codex-project');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_codex_legacy',
      projectName: 'legacy-codex-project',
      projectRoot,
    }, tmpMycoHome);

    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service-dev');

    expect(result.projectsVisited).toBe(1);
    expect(result.outcomes[0].error).toBeUndefined();
    expect(result.outcomes[0].cleanedSymbionts).toContain('codex');

    // The Myco MCP block must be gone. Either the file is removed
    // entirely (uninstall stripped the only Myco-owned section) or the
    // section header no longer appears.
    const configPath = path.join(projectRoot, '.codex', 'config.toml');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      expect(raw).not.toContain('[mcp_servers.myco]');
      // The collision shape that broke ten-second-tom: stdio command
      // + url in the same record. Stripping the entire myco section
      // is the only safe outcome.
      expect(raw).not.toMatch(/\[mcp_servers\.myco\]/);
    }
  });

  it('removes the Myco-generated project-local .codex/hooks.json', () => {
    const grove = createGrove('default', tmpMycoHome, { servedBy: 'service-dev' });
    const projectRoot = seedPreMigrationCodexProject('legacy-codex-project');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_codex_legacy',
      projectName: 'legacy-codex-project',
      projectRoot,
    }, tmpMycoHome);

    const hooksPath = path.join(projectRoot, '.codex', 'hooks.json');
    expect(fs.existsSync(hooksPath)).toBe(true);

    runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service-dev');

    // After the walker the hooks file is either gone (every command was
    // Myco-owned, so the file collapsed empty and was unlinked) or what
    // remains contains zero Myco launcher references.
    if (fs.existsSync(hooksPath)) {
      const raw = fs.readFileSync(hooksPath, 'utf-8');
      expect(raw).not.toContain('myco-run.cjs');
      expect(raw).not.toContain('--symbiont codex');
    }
  });

  it('reports the project as cleaned (noOp=false) so the audit log surfaces the migration', () => {
    const grove = createGrove('default', tmpMycoHome, { servedBy: 'service-dev' });
    const projectRoot = seedPreMigrationCodexProject('legacy-codex-project');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_codex_legacy',
      projectName: 'legacy-codex-project',
      projectRoot,
    }, tmpMycoHome);

    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service-dev');

    expect(result.projectsCleaned).toBe(1);
    expect(result.projectsErrored).toBe(0);
    expect(result.outcomes[0].noOp).toBe(false);
  });

  it('is idempotent — running the walker a second time is a no-op for the same project', () => {
    const grove = createGrove('default', tmpMycoHome, { servedBy: 'service-dev' });
    const projectRoot = seedPreMigrationCodexProject('legacy-codex-project');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_codex_legacy',
      projectName: 'legacy-codex-project',
      projectRoot,
    }, tmpMycoHome);

    runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service-dev');
    const second = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service-dev');

    expect(second.outcomes[0].noOp).toBe(true);
    expect(second.outcomes[0].cleanedSymbionts).toHaveLength(0);
  });
});
