import { defineConfig } from 'tsup';

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
  dts: false,
  external: [
    'better-sqlite3',
    'sqlite-vec',
    '@anthropic-ai/claude-agent-sdk',
    'yaml',
  ],
});
