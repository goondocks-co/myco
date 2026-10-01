import { afterEach, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { ApiError } from '../../packages/myco-server/ui/src/lib/api';
import { ErrorState } from '../../packages/myco-server/ui/src/design';

afterEach(cleanup);

for (const body of [
  { error: 'bad_request', reasonCode: 'invalid_request', reason: 'server prose must stay off the page' },
  { applied: false, reason: 'invalid_value', detail: 'server prose must stay off the page' },
  { applied: false, reason: 'malformed', detail: 'server prose must stay off the page' },
  { error: 'forbidden', reason: 'server prose must stay off the page' },
]) {
  it(`words ${body.error ?? body.reason} without quoting its detail`, () => {
    render(<ErrorState error={new ApiError(400, body)} />);
    expect(screen.getByRole('alert').textContent).toBe('The server refused this');
    expect(document.body.textContent).not.toContain('server prose must stay off the page');
  });
}
