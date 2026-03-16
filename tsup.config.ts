import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

export default defineConfig({
  entry: {
    // Thin hooks — no native deps, no entry wrapper needed
    'src/hooks/session-end': 'src/hooks/session-end.ts',
    'src/hooks/stop': 'src/hooks/stop.ts',
    'src/hooks/user-prompt-submit': 'src/hooks/user-prompt-submit.ts',
    'src/hooks/post-tool-use': 'src/hooks/post-tool-use.ts',
    // Entry wrappers — dynamic import so main() is called explicitly
    // (tsup code-splitting moves the module into a chunk whose filename
    // differs from process.argv[1], so inline entry-point guards break)
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
  // Native modules cannot be bundled — they need platform-specific binaries.
  // Claude Code installs node_modules (including native deps) when loading
  // plugins from the marketplace, so they're available at runtime.
  external: ['better-sqlite3', 'sqlite-vec'],
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
  ],
  onSuccess: async () => {
    // Copy prompt .md files next to bundled output so loadPrompt() can find them
    const promptSrc = 'src/prompts';
    const promptDest = 'dist/src/prompts';
    mkdirSync(promptDest, { recursive: true });
    for (const file of readdirSync(promptSrc)) {
      if (file.endsWith('.md')) {
        copyFileSync(path.join(promptSrc, file), path.join(promptDest, file));
      }
    }
  },
});
