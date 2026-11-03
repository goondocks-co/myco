import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { TextOrBlob } from '../../packages/myco-server/ui/src/features/sessions/StoredText';
import { createQueryClient } from '../../packages/myco-server/ui/src/lib/query-client';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

describe('processed text revisions', () => {
  it('reads a fresh document locator while the body identity and digest stay mounted', async () => {
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      return new URL(url, 'http://localhost').searchParams.get('revision') === 'old'
        ? Response.json({ error: 'stale_cursor' }, { status: 409 }) : new Response('Complete retained body');
    }) as typeof fetch;
    const tree = (revision: string) => (
      <QueryClientProvider client={client}>
        <TextOrBlob projectId="project" text={null} blobKey={'a'.repeat(64)}
          body={{ kind: 'response', id: 'reply', at: { sessionId: 'session', generation: 1, owner: 'prompt', page: 0, revision } }} />
      </QueryClientProvider>
    );
    const view = render(tree('old'));
    expect(await screen.findByText('The stored text could not be read.')).toBeTruthy();
    view.rerender(tree('current'));
    expect(await screen.findByText('Complete retained body', {}, { timeout: 1000 })).toBeTruthy();
    expect(requested.map(url => new URL(url, 'http://localhost').searchParams.get('revision'))).toEqual(['old', 'current']);
    view.unmount();
    client.clear();
  });

  for (const kind of ['prompt', 'response', 'plan', 'tool-input', 'tool-output'] as const) {
    it(`reads a revised spilled ${kind} while its logical field stays mounted in the same query client`, async () => {
      const client = createQueryClient();
      const body = { kind, id: 'same logical field' };
      const first = `Complete first ${kind} body`;
      const revised = `Complete revised ${kind} body`;
      let current = first;
      const requested: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requested.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return new Response(current);
      }) as typeof fetch;
      const tree = (blobKey: string) => (
        <QueryClientProvider client={client}>
          <TextOrBlob projectId="shared-project" text={null} blobKey={blobKey} body={body} />
        </QueryClientProvider>
      );
      const view = render(tree('a'.repeat(64)));
      expect(await screen.findByText(first)).toBeTruthy();
      current = revised;
      view.rerender(tree('b'.repeat(64)));
      expect(await screen.findByText(revised, {}, { timeout: 1000 })).toBeTruthy();
      expect(screen.queryByText(first)).toBeNull();
      const typedPath = `/api/projects/shared-project/processed/${kind}/same%20logical%20field`;
      expect(requested).toEqual([typedPath, typedPath]);
      view.unmount();
      client.clear();
    });
  }
});
