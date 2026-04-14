// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Layout from '../../packages/myco-collective/ui/src/layout/Layout';
import { ThemeProvider } from '../../packages/myco-collective/ui/src/providers/theme';

describe('Collective UI shell', () => {
  it('renders the Myco-style collective shell and nested content', () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/search']}>
          <Routes>
            <Route element={<Layout collectiveName="OSS Collective" onLogout={() => {}} />}>
              <Route path="/search" element={<div>Search body</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(screen.getAllByText('myco').length).toBeGreaterThan(0);
    expect(screen.getAllByText('OSS Collective').length).toBeGreaterThan(0);
    expect(screen.getByRole('navigation', { name: 'Collective navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'MCP' })).toHaveAttribute('href', '/mcp-settings');
    expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', '/search');
    expect(screen.getByText('Search body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear Admin Token' })).toBeInTheDocument();
  });
});
