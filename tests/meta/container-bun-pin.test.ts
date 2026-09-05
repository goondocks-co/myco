/**
 * Meta gate: the shipped images run the bun this repository pins.
 *
 * `.bun-version` is what CI and the release binary take their runtime from, and
 * behaviour differs between bun versions. An image built on another one runs
 * the agent's own code on a runtime nothing else in this repository tests.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('meta: the container runtime', () => {
  it('runs both shipped images on the bun this repository pins', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const pinned = readFileSync(join(root, '.bun-version'), 'utf8').trim();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    for (const image of ['packages/myco-server/Dockerfile', 'packages/myco-server/harness/Dockerfile']) {
      const text = readFileSync(join(root, image), 'utf8');
      // The version is an argument with the pin as its default, and the image
      // is built from it — never a literal tag beside the pin.
      expect({ image, arg: new RegExp(`^ARG BUN_VERSION=${pinned}$`, 'm').test(text) }).toEqual({ image, arg: true });
      expect({ image, literal: /FROM oven\/bun:\d/.test(text) }).toEqual({ image, literal: false });
    }
  });
});
