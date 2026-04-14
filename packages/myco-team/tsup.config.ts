import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    main: 'src/main.ts',
  },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  define: {
    '__MYCO_TEAM_VERSION__': JSON.stringify(pkg.version),
  },
  dts: false,
  external: [
    'better-sqlite3',
    'sqlite-vec',
    '@anthropic-ai/claude-agent-sdk',
    'yaml',
  ],
});
