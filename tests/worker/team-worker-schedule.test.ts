import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('team worker deployment config', () => {
  it('declares a cron trigger for collective refresh', () => {
    const wranglerToml = fs.readFileSync(
      path.join(process.cwd(), 'packages', 'myco-team', 'worker', 'wrangler.toml'),
      'utf-8',
    );

    expect(wranglerToml).toMatch(/\[triggers\][\s\S]*crons = \["\*\/5 \* \* \* \*"\]/);
  });
});
