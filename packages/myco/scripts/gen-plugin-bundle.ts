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
  ACCESS_KEY_COSTS,
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

// --- clients -----------------------------------------------------------------
// One row per client: the dialect it substitutes configuration values in, the
// file it reads its MCP entry from, and the manifest it reads. The payload is
// shared; a client differs only in these three. Holding them together in one
// row is what stops a manifest declaring a value in one dialect while the file
// it points at references another — the drift a per-client hand-written bundle
// invites, and which a set-union gate over all files cannot see.

/** How one client spells a reference to a configuration value. */
export type Dialect = (key: PluginConfigKey) => string;

export interface Client {
  readonly id: string;
  /** Where this client reads its MCP entry. */
  readonly mcpPath: string;
  readonly dialect: Dialect;
  readonly mcp: (ref: Dialect) => Record<string, unknown>;
  /** Its own manifest, where it wants one beyond the portable `plugin.json`. */
  readonly manifestPath?: string;
  readonly manifest?: (ref: Dialect) => Record<string, unknown>;
}

const endpoint = (ref: string): string => `${ref}${MCP_PATH}`;
const bearer = (ref: string): string => `Bearer ${ref}`;

/** Agent Plugins 1.0 and VS Code Copilot: values declared as `inputs` beside the entry. */
const portableDialect: Dialect = (key) => `\${input:${key.id}}`;
/** Claude Code: values declared as `userConfig` in its manifest. */
const claudeDialect: Dialect = (key) => `\${user_config.${key.id}}`;
/** Cursor and Antigravity: an upper-case name, declared as a plugin variable or set in the environment. */
const upperDialect: Dialect = (key) => `\${${key.id.toUpperCase()}}`;

const httpEntry = (ref: Dialect): Record<string, unknown> => ({
  type: 'http',
  url: endpoint(ref(DEPLOYMENT_URL_KEY)),
  headers: { Authorization: bearer(ref(ACCESS_KEY_KEY)) },
});

export const CLIENTS: readonly Client[] = [
  {
    id: 'agent-plugins',
    mcpPath: 'mcp.json',
    dialect: portableDialect,
    mcp: (ref) => ({
      inputs: PLUGIN_CONFIG_KEYS.map((key) => ({
        id: key.id,
        type: 'promptString',
        description: key.description,
        password: key.secret,
      })),
      servers: { [MCP_SERVER_NAME]: httpEntry(ref) },
    }),
    manifestPath: 'plugin.json',
    manifest: () => ({
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
    }),
  },
  {
    id: 'claude-code',
    mcpPath: '.mcp.json',
    dialect: claudeDialect,
    mcp: (ref) => ({ mcpServers: { [MCP_SERVER_NAME]: httpEntry(ref) } }),
    manifestPath: '.claude-plugin/plugin.json',
    manifest: () => ({
      name: PLUGIN_NAME,
      version: version(),
      description: PLUGIN_DESCRIPTION,
      author: { name: PLUGIN_AUTHOR },
      homepage: PLUGIN_HOMEPAGE,
      license: PLUGIN_LICENSE,
      keywords: [...PLUGIN_KEYWORDS],
      // `title` is required on every entry, and a masked value is `sensitive`,
      // not `secret` — both established by running `claude plugin validate`,
      // which is the only authority for this manifest's schema.
      userConfig: Object.fromEntries(
        PLUGIN_CONFIG_KEYS.map((key) => [
          key.id,
          {
            type: 'string',
            title: key.label,
            description: key.description,
            required: true,
            ...(key.secret ? { sensitive: true } : {}),
          },
        ]),
      ),
    }),
  },
  {
    id: 'cursor',
    // Its own file: Cursor substitutes its declared `variables`, which the
    // portable entry's placeholders are not, so pointing it at `mcp.json` would
    // leave the literal text in the URL it dials.
    mcpPath: '.cursor-plugin/mcp.json',
    dialect: upperDialect,
    mcp: (ref) => ({ mcpServers: { [MCP_SERVER_NAME]: httpEntry(ref) } }),
    manifestPath: '.cursor-plugin/plugin.json',
    manifest: (ref) => ({
      name: PLUGIN_NAME,
      version: version(),
      description: PLUGIN_DESCRIPTION,
      skills: './skills/',
      mcpServers: './.cursor-plugin/mcp.json',
      variables: PLUGIN_CONFIG_KEYS.map((key) => ({
        name: ref(key).slice(2, -1),
        description: key.description,
        ...(key.secret ? { secret: true } : {}),
      })),
    }),
  },
  {
    id: 'antigravity',
    // A remote server names its endpoint `serverUrl` here, and the key rides the
    // same Authorization header every other client sends.
    mcpPath: 'mcp_config.json',
    dialect: upperDialect,
    mcp: (ref) => ({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          serverUrl: endpoint(ref(DEPLOYMENT_URL_KEY)),
          headers: { Authorization: bearer(ref(ACCESS_KEY_KEY)) },
        },
      },
    }),
  },
  {
    id: 'codex',
    // Reads the portable entry; its manifest adds the path pointers Codex wants
    // and declares no value of its own.
    mcpPath: 'mcp.json',
    dialect: portableDialect,
    mcp: (ref) => ({
      inputs: PLUGIN_CONFIG_KEYS.map((key) => ({ id: key.id, type: 'promptString', description: key.description, password: key.secret })),
      servers: { [MCP_SERVER_NAME]: httpEntry(ref) },
    }),
    manifestPath: '.codex-plugin/plugin.json',
    manifest: () => ({
      name: PLUGIN_NAME,
      version: version(),
      description: PLUGIN_DESCRIPTION,
      author: { name: PLUGIN_AUTHOR },
      homepage: PLUGIN_HOMEPAGE,
      license: PLUGIN_LICENSE,
      keywords: [...PLUGIN_KEYWORDS],
      skills: './skills/',
      mcpServers: './mcp.json',
    }),
  },
];

/**
 * The bundle's own README: what the plugin is, what it does not carry, and what
 * the access key costs. The costs come from the spec, so the document and the
 * gate that holds it cannot say different things.
 */
function readme(): string {
  return `# Myco

${PLUGIN_DESCRIPTION}

## What this plugin carries

Skills, and one MCP entry pointing at your Myco deployment. That is the whole of it.

It carries **no binary and no hooks**. A hook command is the absolute path of the \`myco\` binary on your own machine, resolved when that binary is installed, so a downloadable bundle has neither the binary nor the path it will live at. Sessions are therefore not captured by the plugin alone.

Installing the binary as well adds session capture, plan capture, import and the worker. The **myco-setup** skill in this bundle walks through it.

## Configuring it

Your client asks for two values the first time it loads the plugin:

${PLUGIN_CONFIG_KEYS.map((key) => `- **${key.label}** — ${key.description}`).join('\n')}

## What the access key costs

${ACCESS_KEY_COSTS.map((cost) => `- ${cost}`).join('\n')}

Installing the binary replaces the key with a credential of your own, which is the other reason to finish setup.

## License

${PLUGIN_LICENSE}. ${PLUGIN_HOMEPAGE}
`;
}

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

/**
 * The catalogue the Deployment answers `myco_skills` from: listing text only.
 *
 * No skill body reaches this module, and that is a size constraint rather than a
 * preference. The Worker script the binary carries has a measured ceiling that
 * the free plan makes real; nine SKILL.md bodies are 57 KiB and every skill
 * added grows it, so a Deployment carrying them puts documentation inside a
 * script that is bounded. The bodies ship where they are used — the plugin
 * installs them on disk for every client that can call the tool.
 */
function catalogue(skills: readonly Skill[]): string {
  const entries = skills.map((s) => ({ name: s.name, description: s.description, when_to_use: s.whenToUse }));
  return `/*
 * AUTO-GENERATED by packages/myco/scripts/gen-plugin-bundle.ts — DO NOT EDIT.
 *
 * What a client lists a shipped skill by. Bodies are deliberately absent: this
 * module is bundled into the Cloudflare Worker, whose size ceiling is a free-tier
 * tripwire, and a skill body is served from the plugin that installed it.
 */

/** One shipped skill, as a caller chooses between them. */
export interface ShippedSkill {
  readonly name: string;
  readonly description: string;
  readonly when_to_use: string;
}

export const SHIPPED_SKILLS: readonly ShippedSkill[] = ${JSON.stringify(entries, null, 2)};
`;
}

/**
 * The member binary's bundle: every file of every shipped skill, which the
 * installer writes to disk. It is the member's alone — importing it from the
 * Deployment would carry all of it into the Worker script.
 */
function memberBundle(skills: readonly Skill[]): string {
  const files = Object.fromEntries(
    skills.map((s) => [s.name, Object.fromEntries([...s.files].sort(([a], [b]) => (a < b ? -1 : 1)))]),
  );
  return `// AUTO-GENERATED by scripts/gen-plugin-bundle.ts — DO NOT EDIT.
// Run \`npm run codegen\` after changing packages/myco/skills/.
export const BUNDLED_SKILLS: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(files, null, 2)};
`;
}


// --- emit --------------------------------------------------------------------

function bundleFiles(skills: readonly Skill[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const client of CLIENTS) {
    out.set(client.mcpPath, json(client.mcp(client.dialect)));
    if (client.manifestPath !== undefined && client.manifest !== undefined) {
      out.set(client.manifestPath, json(client.manifest(client.dialect)));
    }
  }
  out.set('README.md', readme());
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
  files.set(MEMBER_BUNDLE_PATH, memberBundle(skills));

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

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
