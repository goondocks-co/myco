import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig({
  entry: {
    main: 'src/main.ts',
  },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  define: {
    __MYCO_HUB_VERSION__: JSON.stringify(pkg.version),
  },
  dts: false,
});
