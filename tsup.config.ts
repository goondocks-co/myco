import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export default defineConfig({
  entry: {
    // Thin hooks — delegate to daemon
    'src/hooks/session-end': 'src/hooks/session-end.ts',
    'src/hooks/stop': 'src/hooks/stop.ts',
    'src/hooks/user-prompt-submit': 'src/hooks/user-prompt-submit.ts',
    'src/hooks/post-tool-use': 'src/hooks/post-tool-use.ts',
    // Entry wrappers — dynamic import so tsup code-splitting works
    // (chunk filenames differ from process.argv[1])
    'src/hooks/session-start': 'src/entries/session-start.ts',
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
  // Inject createRequire shim so CJS deps (yaml) can require Node builtins
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  external: [],
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
    '@electric-sql/pglite',
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
  },
});
