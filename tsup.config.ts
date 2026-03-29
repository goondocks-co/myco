import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: {
    // Entry wrappers — all hooks now use explicit main() calls
    'src/hooks/session-start': 'src/entries/session-start.ts',
    'src/hooks/session-end': 'src/entries/session-end.ts',
    'src/hooks/stop': 'src/entries/stop.ts',
    'src/hooks/user-prompt-submit': 'src/entries/user-prompt-submit.ts',
    'src/hooks/post-tool-use': 'src/entries/post-tool-use.ts',
    'src/mcp/server': 'src/entries/mcp-server.ts',
    'src/cli': 'src/entries/cli.ts',
    'src/daemon/main': 'src/entries/daemon.ts',
  },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  splitting: true,
  sourcemap: true,
  clean: true,
  define: {
    '__MYCO_VERSION__': JSON.stringify(pkg.version),
  },
  // Inject createRequire shim so CJS deps (yaml) can require Node builtins
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  external: [
    'better-sqlite3',
    'sqlite-vec',
    '@anthropic-ai/claude-agent-sdk',
  ],
  // Do not generate .d.ts — this is a plugin, not a library
  dts: false,
  // Bundle all other dependencies (yaml, zod, gray-matter, etc.)
  noExternal: [
    'yaml',
    'zod',
    'gray-matter',
    'chokidar',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    // better-sqlite3 is a native addon — can't be bundled. Agent SDK spawns subprocesses.
  ],
  onSuccess: async () => {
    // Copy .md files next to bundled output so loaders can find them
    for (const subdir of ['prompts', 'templates']) {
      const src = `src/${subdir}`;
      const dest = `dist/src/${subdir}`;
      mkdirSync(dest, { recursive: true });
      for (const file of readdirSync(src)) {
        if (file.endsWith('.md')) {
          copyFileSync(path.join(src, file), path.join(dest, file));
        }
      }
    }

    // Copy agent definition YAML files and prompt .md files
    const agentDefs = 'src/agent/definitions';
    const agentDefsDest = `dist/src/agent/definitions`;
    mkdirSync(agentDefsDest, { recursive: true });
    for (const file of readdirSync(agentDefs)) {
      if (file.endsWith('.yaml')) {
        copyFileSync(path.join(agentDefs, file), path.join(agentDefsDest, file));
      }
    }
    const agentTasksSrc = path.join(agentDefs, 'tasks');
    if (existsSync(agentTasksSrc)) {
      const agentTasksDest = path.join(agentDefsDest, 'tasks');
      mkdirSync(agentTasksDest, { recursive: true });
      for (const file of readdirSync(agentTasksSrc)) {
        if (file.endsWith('.yaml')) {
          copyFileSync(path.join(agentTasksSrc, file), path.join(agentTasksDest, file));
        }
      }
    }

    // Copy agent prompt .md files
    const agentPrompts = 'src/agent/prompts';
    if (existsSync(agentPrompts)) {
      const agentPromptsDest = `dist/src/agent/prompts`;
      mkdirSync(agentPromptsDest, { recursive: true });
      for (const file of readdirSync(agentPrompts)) {
        if (file.endsWith('.md')) {
          copyFileSync(path.join(agentPrompts, file), path.join(agentPromptsDest, file));
        }
      }
    }

    // Copy symbiont manifest YAML files
    const symbiontManifests = 'src/symbionts/manifests';
    if (existsSync(symbiontManifests)) {
      const symbiontManifestsDest = 'dist/src/symbionts/manifests';
      mkdirSync(symbiontManifestsDest, { recursive: true });
      for (const file of readdirSync(symbiontManifests)) {
        if (file.endsWith('.yaml')) {
          copyFileSync(path.join(symbiontManifests, file), path.join(symbiontManifestsDest, file));
        }
      }
    }

    // Copy symbiont registration templates (JSON per agent + shared .md)
    const symbiontTemplates = 'src/symbionts/templates';
    if (existsSync(symbiontTemplates)) {
      const destBase = 'dist/src/symbionts/templates';
      mkdirSync(destBase, { recursive: true });
      for (const entry of readdirSync(symbiontTemplates, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // Per-agent template directories (JSON files)
          const srcDir = path.join(symbiontTemplates, entry.name);
          const destDir = path.join(destBase, entry.name);
          mkdirSync(destDir, { recursive: true });
          for (const file of readdirSync(srcDir)) {
            if (file.endsWith('.json')) {
              copyFileSync(path.join(srcDir, file), path.join(destDir, file));
            }
          }
        } else if (entry.name.endsWith('.md') || entry.name.endsWith('.cjs')) {
          // Shared templates (root-level .md and .cjs files like hook-guard.cjs)
          copyFileSync(path.join(symbiontTemplates, entry.name), path.join(destBase, entry.name));
        }
      }
    }
  },
});
