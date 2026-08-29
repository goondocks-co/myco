/**
 * The dashboard renders an attachment inline only when the blob route would serve
 * it with its stored type. The route's set lives in `api/blobs.ts`; the dashboard
 * cannot import it, so the two are pinned against each other here — a type added
 * to one side without the other renders a broken image or downloads a picture.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../packages/myco-server/src/api/blobs.ts', import.meta.url));
const UI = fileURLToPath(new URL('../../packages/myco-server/ui/src/hooks/use-sessions.ts', import.meta.url));

const listed = (source: string, marker: RegExp): string[] => {
  const block = marker.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
};

describe('renderable image types', () => {
  it('are the same set on the blob route and in the dashboard', () => {
    const server = listed(readFileSync(SERVER, 'utf8'), /const RENDERABLE = new Set\(\[([\s\S]*?)\]\)/).filter((t) => t.startsWith('image/'));
    const ui = listed(readFileSync(UI, 'utf8'), /RENDERABLE_IMAGE_TYPES: readonly string\[\] = \[([\s\S]*?)\]/);
    expect(server.length).toBeGreaterThan(0);
    expect(ui).toEqual(server);
  });
});
