import { afterEach, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TelemetryKeys } from '../../packages/myco-server/ui/src/features/admin/settings/TelemetryKeys';
import { parentWords } from '../../packages/myco-server/ui/src/features/sessions/Lineage';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
it('shows connection counts and a key header once, then revokes with removal explained', async () => {
  let revoked = false;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (init?.method === 'POST' && path.endsWith('/revoke')) { revoked = true; return Response.json({ revoked: true }); }
    if (init?.method === 'POST') return Response.json({ key: 'example-key', headers: 'Authorization=Bearer%20example-key', endpoint: 'https://example.test' });
    return Response.json({ endpoint: 'https://example.test', keys: [{ id: 'tk_test', label: 'Build service', lastUsedAt: Date.now(), revokedAt: revoked ? Date.now() : null, accepted: 8, rejected: 1 }] });
  }) as typeof fetch;
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><TelemetryKeys /></QueryClientProvider>);
  expect(await screen.findByText('8 accepted · 1 rejected spans in the last day')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add telemetry key' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My sender' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
  expect(await screen.findByText('Authorization=Bearer%20example-key')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByText('Authorization=Bearer%20example-key')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(await screen.findByText(/Its stored spans, invocation facts and reported lineage will be removed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
  await waitFor(() => expect(revoked).toBe(true));
  expect(parentWords({ parentId: 'a', childId: 'b', kind: 'launched', reason: null, source: 'telemetry', serviceName: 'Build service', inferred: true }, 'the lead'))
    .toBe('Probably started by the lead · reported by Build service');
});
