/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Codegen: the distributable plugin bundle, the marketplace manifest, and the
 * skill catalogue the Deployment serves.
 *
 * One directory carries every client's manifest over one skills tree. The
 * clients differ only in the filename their manifest lives at, its schema, and
 * how they ask the installing person for the two configuration values; the
 * payload is identical, so duplicating a bundle per client would only let those
 * manifests drift. Each emitter below owns one client's dialect and nothing
 * else.
 *
 * `--check` byte-compares every emitted file and exits non-zero on drift, so a
 * forgotten run fails CI rather than shipping a bundle that disagrees with the
 * skills tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listSkillDirs, readTextFile, walk } from './codegen-bundle.mjs';
import {
  ACCESS_KEY_KEY,
  AGENT_PLUGINS_SCHEMA,
  DEPLOYMENT_URL_KEY,
  MCP_PATH,
  MCP_SERVER_NAME,
  PLUGIN_AUTHOR,
  PLUGIN_CONFIG_KEYS,
  PLUGIN_DESCRIPTION,
  PLUGIN_HOMEPAGE,
  PLUGIN_KEYWORDS,
  PLUGIN_LICENSE,
  PLUGIN_NAME,
} from '../src/plugins/spec.js';

const LABEL = 'gen-plugin-bundle';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '../..');
const SKILLS_DIR = path.resolve(PKG_ROOT, 'skills');
const EVALS_DIR = path.resolve(PKG_ROOT, 'evals');
const BUNDLE_DIR = path.resolve(REPO_ROOT, 'plugins', PLUGIN_NAME);
const MARKETPLACE_PATH = path.resolve(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const CATALOGUE_PATH = path.resolve(REPO_ROOT, 'packages/myco-shared/src/skills.generated.ts');
const MEMBER_BUNDLE_PATH = path.resolve(PKG_ROOT, 'src/symbionts/skills.generated.ts');

const version = (): string =>
  (JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface Skill {
  readonly name: string;
  readonly files: ReadonlyMap<string, string>;
  readonly markdown: string;
  readonly description: string;
  readonly whenToUse: string;
}

/**
 * The frontmatter value for `key`, with a folded block scalar rejoined into one
 * line. Enough YAML for two string fields written the two ways the tree writes
 * them; a dependency would buy nothing a gate does not already cover.
 */
function frontmatterValue(markdown: string, key: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (match === null) throw new Error(`[${LABEL}] no frontmatter`);
  const lines = match[1].split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return '';
  const head = lines[start].slice(key.length + 1).trim();
  if (head !== '>-' && head !== '>' && head !== '|' && head !== '|-') return head;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line) || line.trim() === '') break;
    body.push(line.trim());
  }
  return body.join(' ');
}

function readSkills(): Skill[] {
  return listSkillDirs(SKILLS_DIR).map((name: string) => {
    const dir = path.join(SKILLS_DIR, name);
    const files = new Map<string, string>();
    for (const abs of walk(dir)) files.set(path.relative(dir, abs).split(path.sep).join('/'), readTextFile(abs));
    const markdown = files.get('SKILL.md');
    if (markdown === undefined) throw new Error(`[${LABEL}] ${name} has no SKILL.md`);
    return {
      name,
      files,
      markdown,
      description: frontmatterValue(markdown, 'description'),
      whenToUse: frontmatterValue(markdown, 'when_to_use'),
    };
  });
}

// --- per-client emitters -----------------------------------------------------
// Each answers the files one client reads. The payload is shared; only the
// filename, the schema and the way the two configuration values are asked for
// differ.

/** The MCP endpoint, spelled with one client's own placeholder syntax. */
const endpoint = (urlRef: string): string => `${urlRef}${MCP_PATH}`;
const bearer = (keyRef: string): string => `Bearer ${keyRef}`;

/** Agent Plugins 1.0: the portable manifest Codex, Cursor, VS Code Copilot and Antigravity all accept. */
const agentPluginsManifest = (): Record<string, unknown> => ({
  $schema: AGENT_PLUGINS_SCHEMA,
  name: PLUGIN_NAME,
  version: version(),
  description: PLUGIN_DESCRIPTION,
  author: { name: PLUGIN_AUTHOR },
  homepage: PLUGIN_HOMEPAGE,
  license: PLUGIN_LICENSE,
  keywords: [...PLUGIN_KEYWORDS],
  skills: './skills/',
  experimental: { evals: './evals/' },
});

/** The portable MCP entry. VS Code reads its `inputs` from this same file. */
const agentPluginsMcp = (): Record<string, unknown> => ({
  inputs: PLUGIN_CONFIG_KEYS.map((key) => ({
    id: key.id,
    type: 'promptString',
    description: key.description,
    password: key.secret,
  })),
  servers: {
    [MCP_SERVER_NAME]: {
      type: 'http',
      url: endpoint(`\${input:${DEPLOYMENT_URL_KEY.id}}`),
      headers: { Authorization: bearer(`\${input:${ACCESS_KEY_KEY.id}}`) },
    },
  },
});

/** Claude Code: its own manifest directory, `userConfig`, and a dot-prefixed MCP file. */
const claudeCodeManifest = (): Record<string, unknown> => ({
  name: PLUGIN_NAME,
  version: version(),
  description: PLUGIN_DESCRIPTION,
  author: { name: PLUGIN_AUTHOR },
  homepage: PLUGIN_HOMEPAGE,
  license: PLUGIN_LICENSE,
  keywords: [...PLUGIN_KEYWORDS],
  userConfig: Object.fromEntries(
    PLUGIN_CONFIG_KEYS.map((key) => [
      key.id,
      { type: 'string', description: key.description, required: true, ...(key.secret ? { secret: true } : {}) },
    ]),
  ),
});

const claudeCodeMcp = (): Record<string, unknown> => ({
  mcpServers: {
    [MCP_SERVER_NAME]: {
      type: 'http',
      url: endpoint(`\${user_config.${DEPLOYMENT_URL_KEY.id}}`),
      headers: { Authorization: bearer(`\${user_config.${ACCESS_KEY_KEY.id}}`) },
    },
  },
});

/** Cursor: its own manifest directory and `variables`, referenced as `${VAR}`. */
const cursorManifest = (): Record<string, unknown> => ({
  name: PLUGIN_NAME,
  version: version(),
  description: PLUGIN_DESCRIPTION,
  skills: './skills/',
  mcpServers: './mcp.json',
  variables: PLUGIN_CONFIG_KEYS.map((key) => ({
    name: key.id.toUpperCase(),
    description: key.description,
    ...(key.secret ? { secret: true } : {}),
  })),
});

/** Codex: its own manifest directory with path pointers into the shared payload. */
const codexManifest = (): Record<string, unknown> => ({
  name: PLUGIN_NAME,
  version: version(),
  description: PLUGIN_DESCRIPTION,
  author: { name: PLUGIN_AUTHOR },
  homepage: PLUGIN_HOMEPAGE,
  license: PLUGIN_LICENSE,
  keywords: [...PLUGIN_KEYWORDS],
  skills: './skills/',
  mcpServers: './mcp.json',
});

/** Antigravity: a remote server names its endpoint `serverUrl`, not `url`. */
const antigravityMcp = (): Record<string, unknown> => ({
  mcpServers: {
    [MCP_SERVER_NAME]: { serverUrl: endpoint(`\${${DEPLOYMENT_URL_KEY.id.toUpperCase()}}`) },
  },
});

/** The marketplace manifest, at the repository root where every client that reads a git repo looks. */
const marketplace = (): Record<string, unknown> => ({
  name: 'goondocks',
  owner: { name: PLUGIN_AUTHOR, url: PLUGIN_HOMEPAGE },
  plugins: [
    {
      name: PLUGIN_NAME,
      source: `./plugins/${PLUGIN_NAME}`,
      description: PLUGIN_DESCRIPTION,
      version: version(),
      license: PLUGIN_LICENSE,
      homepage: PLUGIN_HOMEPAGE,
      keywords: [...PLUGIN_KEYWORDS],
    },
  ],
});

/** The catalogue the Deployment answers `myco_skills` from, and the member binary re-exports. */
function catalogue(skills: readonly Skill[]): string {
  const entries = skills.map((s) => ({
    name: s.name,
    description: s.description,
    when_to_use: s.whenToUse,
    content: s.markdown,
  }));
  const files = Object.fromEntries(skills.map((s) => [s.name, Object.fromEntries([...s.files].sort(([a], [b]) => (a < b ? -1 : 1)))]));
  return `/*
 * AUTO-GENERATED by packages/myco/scripts/gen-plugin-bundle.ts — DO NOT EDIT.
 *
 * The skills that ship with Myco, held once. The Deployment answers
 * \`myco_skills\` from \`SHIPPED_SKILLS\`; the member binary writes
 * \`SHIPPED_SKILL_FILES\` to disk through its own re-export. Two consumers, one
 * set of bytes, so a skill cannot read one way over MCP and another on disk.
 */

/** One shipped skill: the text a client lists it by, and the SKILL.md a caller asks for in full. */
export interface ShippedSkill {
  readonly name: string;
  readonly description: string;
  readonly when_to_use: string;
  readonly content: string;
}

export const SHIPPED_SKILLS: readonly ShippedSkill[] = ${JSON.stringify(entries, null, 2)};

/** Every file of every shipped skill, keyed by skill name then by path within the skill. */
export const SHIPPED_SKILL_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(files, null, 2)};
`;
}

/**
 * The member binary's bundle. A re-export rather than a second copy of the
 * bytes: `BUNDLED_SKILLS` keeps the name and shape its consumers already read,
 * and the content it names is the catalogue the Deployment serves.
 */
const memberBundle = (): string => `// AUTO-GENERATED by scripts/gen-plugin-bundle.ts — DO NOT EDIT.
// Run \`npm run codegen\` after changing packages/myco/skills/.
export { SHIPPED_SKILL_FILES as BUNDLED_SKILLS } from '@goondocks/myco-shared/skills';
`;

// --- emit --------------------------------------------------------------------

function bundleFiles(skills: readonly Skill[]): Map<string, string> {
  const out = new Map<string, string>();
  out.set('plugin.json', json(agentPluginsManifest()));
  out.set('mcp.json', json(agentPluginsMcp()));
  out.set('.claude-plugin/plugin.json', json(claudeCodeManifest()));
  out.set('.mcp.json', json(claudeCodeMcp()));
  out.set('.cursor-plugin/plugin.json', json(cursorManifest()));
  out.set('.codex-plugin/plugin.json', json(codexManifest()));
  out.set('mcp_config.json', json(antigravityMcp()));
  for (const skill of skills) {
    for (const [rel, content] of skill.files) out.set(`skills/${skill.name}/${rel}`, content);
  }
  // The trigger cases ride in the bundle so `claude plugin eval` runs against the
  // plugin as published rather than against the checkout it was built from.
  for (const abs of walk(EVALS_DIR)) {
    out.set(`evals/${path.relative(EVALS_DIR, abs).split(path.sep).join('/')}`, readTextFile(abs));
  }
  return out;
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const skills = readSkills();
  const files = new Map<string, string>();
  for (const [rel, content] of bundleFiles(skills)) files.set(path.join(BUNDLE_DIR, rel), content);
  files.set(MARKETPLACE_PATH, json(marketplace()));
  files.set(CATALOGUE_PATH, catalogue(skills));
  files.set(MEMBER_BUNDLE_PATH, memberBundle());

  if (checkMode) {
    const stale: string[] = [];
    for (const [abs, content] of files) {
      let committed: string | null = null;
      try {
        committed = fs.readFileSync(abs, 'utf-8');
      } catch {
        committed = null;
      }
      if (committed !== content) stale.push(path.relative(REPO_ROOT, abs));
    }
    // A file the bundle no longer emits has to fail too: a renamed skill would
    // otherwise leave its directory standing and shipping.
    for (const abs of walk(BUNDLE_DIR)) {
      if (!files.has(abs)) stale.push(`${path.relative(REPO_ROOT, abs)} (no longer emitted)`);
    }
    if (stale.length > 0) {
      process.stderr.write(
        `[${LABEL}] stale, run \`node --import tsx packages/myco/scripts/gen-plugin-bundle.ts\` and commit:\n` +
          `${stale.map((f) => `  ${f}\n`).join('')}`,
      );
      process.exit(1);
    }
    process.stdout.write(`[${LABEL}] plugin bundle is in sync (${skills.length} skills, ${files.size} files)\n`);
    return;
  }

  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  for (const [abs, content] of files) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  process.stdout.write(`[${LABEL}] wrote ${files.size} files (${skills.length} skills)\n`);
}

main();
