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
  // Scoped clean: the build:core script wipes only the files tsup owns and
  // deliberately leaves dist/ui/ alone (owned by vite). tsup's `clean: true`
  // unconditionally wipes outDir, which would destroy the UI bundle if
  // build:core runs without build:ui.
  clean: false,
  dts: false,
});
