// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageScopeBadge } from '../../../packages/myco/ui/src/layout/PageScopeBadge';

function at(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><PageScopeBadge /></MemoryRouter>);
}

describe('PageScopeBadge', () => {
  afterEach(cleanup);
  it('renders nothing on project-scoped routes', () => {
    const { container } = at('/g/default/p/proj-1/sessions');
    expect(container.textContent).toBe('');
  });
  it('shows Grove-wide on grove-scoped routes', () => {
    const { getByText } = at('/g/default/operations');
    expect(getByText(/Grove-wide/i)).toBeTruthy();
  });
  it('shows Machine-wide on machine-scoped routes', () => {
    const { getByText } = at('/settings');
    expect(getByText(/Machine-wide/i)).toBeTruthy();
  });
});
