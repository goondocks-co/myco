import { afterEach, describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

import {
  ConfirmDialog, dayLabel, errorWords, FilterBar, HealthDot, IconButton, SearchableSelect, searchableSelectRank, Select, SEARCHABLE_AFTER,
  ShowMore, Switch, useFilterParams,
} from '../../packages/myco-server/ui/src/design';
import { ApiError } from '../../packages/myco-server/ui/src/lib/api';

afterEach(cleanup);

const PROJECTS = ['myco', 'atlas web', 'field notes', 'ledger', 'infra', 'sandbox', 'docs', 'recipes', 'scratch']
  .map((name) => ({ value: name.replace(/\s/g, '-'), label: name }));

describe('Switch', () => {
  it('is a named switch that reports and flips its state', () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch aria-label="Learn from sessions" checked={on} onCheckedChange={setOn} />;
    }
    render(<Harness />);
    const control = screen.getByRole('switch', { name: 'Learn from sessions' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Select', () => {
  it('becomes searchable past eight options', () => {
    expect(PROJECTS.length).toBeGreaterThan(SEARCHABLE_AFTER);
    render(<Select label="Project" value="myco" onValueChange={() => undefined} options={PROJECTS} />);
    const trigger = screen.getByRole('button', { name: 'Project: myco' });
    fireEvent.click(trigger);
    expect(screen.getByRole('combobox', { name: 'Search project' })).toBeTruthy();
    expect(screen.getAllByRole('option').length).toBe(PROJECTS.length);
  });
});

describe('SearchableSelect', () => {
  it('ranks an exact match first and a separator-free match last', () => {
    expect(searchableSelectRank({ value: 'field-notes', label: 'field notes' }, 'field notes')).toBe(0);
    expect(searchableSelectRank({ value: 'field-notes', label: 'field notes' }, 'fieldnotes')).toBe(5);
    expect(searchableSelectRank({ value: 'myco', label: 'myco' }, 'zzz')).toBeNull();
  });

  it('filters as you type, moves with the arrows, and picks with Enter', async () => {
    const picked: string[] = [];
    render(<SearchableSelect label="Project" value="myco" onValueChange={(v) => picked.push(v)} options={PROJECTS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project: myco' }));
    const search = screen.getByRole('combobox', { name: 'Search project' });
    fireEvent.change(search, { target: { value: 's' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['sandbox', 'scratch', 'atlas web', 'docs', 'field notes', 'recipes']));
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(picked).toEqual(['scratch']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on Escape without picking', () => {
    const picked: string[] = [];
    render(<SearchableSelect label="Project" value="myco" onValueChange={(v) => picked.push(v)} options={PROJECTS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project: myco' }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(picked).toEqual([]);
  });
});

describe('FilterBar with useFilterParams', () => {
  function Page() {
    const filters = useFilterParams(['agent']);
    const location = useLocation();
    return (
      <>
        <FilterBar
          searchLabel="Search sessions"
          query={filters.query}
          onQueryChange={filters.setQuery}
          filters={[{ key: 'agent', label: 'Agent', options: [{ value: 'all', label: 'Every agent' }, { value: 'codex', label: 'Codex' }] }]}
          values={filters.values}
          onFilterChange={filters.setFilter}
          onClear={filters.clear}
          count="34 sessions"
        />
        <output data-testid="search">{location.search}</output>
      </>
    );
  }

  it('keeps the query and filters in the URL and clears both', () => {
    render(<MemoryRouter initialEntries={['/sessions?agent=codex']}><Page /></MemoryRouter>);
    expect(document.querySelectorAll('[data-filter-bar]').length).toBe(1);
    expect(screen.getByRole('combobox', { name: 'Agent' }).textContent).toContain('Codex');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'canopy' } });
    expect(screen.getByTestId('search').textContent).toBe('?agent=codex&q=canopy');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(screen.getByTestId('search').textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Clear search and filters' })).toBeNull();
    expect(screen.getByText('34 sessions')).toBeTruthy();
  });

  it('keeps a query that reads "all", the word that means no filter', () => {
    render(<MemoryRouter initialEntries={['/sessions']}><Page /></MemoryRouter>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'all' } });
    expect(screen.getByTestId('search').textContent).toBe('?q=all');
    expect((screen.getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement).value).toBe('all');
  });
});

describe('ConfirmDialog', () => {
  it('names the action, confirms it, and shows why it failed', () => {
    const confirmed: number[] = [];
    render(
      <ConfirmDialog open onOpenChange={() => undefined} title="Delete this session?" description="Its prompts are removed." confirmLabel="Delete session"
        onConfirm={() => confirmed.push(1)} error="The server had a problem" />,
    );
    expect(screen.getByRole('dialog', { name: 'Delete this session?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    expect(confirmed).toEqual([1]);
    expect(screen.getByRole('alert').textContent).toBe('The server had a problem');
  });
});

describe('words, not colours', () => {
  it('gives every HealthDot a name', () => {
    render(<><HealthDot tone="ok" live label="Claude Code, just now" /><HealthDot tone="bad" showLabel label="Cursor, 3 days ago" /></>);
    expect(screen.getByRole('img', { name: 'Claude Code, just now' })).toBeTruthy();
    expect(screen.getByText('Cursor, 3 days ago')).toBeTruthy();
  });

  it('words a failed read by its status', () => {
    expect(errorWords(new ApiError(403, null)).title).toBe('This page is for an admin.');
    expect(errorWords(new ApiError(404, null)).title).toBe('Not found');
    expect(errorWords(new ApiError(503, { reason: 'busy' }))).toEqual({ title: 'The server had a problem', retry: true });
    expect(errorWords(new TypeError('Failed to fetch')).title).toBe('Could not reach the server');
  });

  it('names days relative to now', () => {
    const now = new Date(2026, 8, 29, 15, 0).getTime();
    expect(dayLabel(new Date(2026, 8, 29, 1, 0).getTime(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 28, 23, 0).getTime(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 8, 24, 9, 0).getTime(), now)).toContain('September 24');
  });

  it('pages with a count and Show more, and hides it at the end', () => {
    const { rerender } = render(<ShowMore shown={20} total={34} noun="sessions" onMore={() => undefined} />);
    expect(screen.getByText('Showing 20 of 34 sessions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
    rerender(<ShowMore shown={34} total={34} noun="sessions" onMore={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('cn', () => {
  it('lets a later class override an earlier one on the design system\'s own scales', async () => {
    const { cn } = await import('../../packages/myco-server/ui/src/lib/cn');
    expect(cn('h-control px-s4 t-control rounded-control', 'w-control px-0 h-[44px] t-body rounded-card')).toBe('w-control px-0 h-[44px] t-body rounded-card');
    expect(cn('gap-s4 p-s6', 'gap-s3 p-s5')).toBe('gap-s3 p-s5');
    // Different properties stay side by side.
    expect(cn('px-s4 py-s2 t-small text-muted')).toBe('px-s4 py-s2 t-small text-muted');
  });

  it('keeps an icon button square, its icon at full size', () => {
    render(<IconButton label="Search"><span data-testid="glyph" /></IconButton>);
    const classes = screen.getByRole('button', { name: 'Search' }).className.split(' ');
    expect(classes).toContain('px-0');
    expect(classes).not.toContain('px-s4');
  });
});

describe('cn and the type scale', () => {
  it('lets a type-scale class replace an earlier size, line height or family', async () => {
    const { cn } = await import('../../packages/myco-server/ui/src/lib/cn');
    expect(cn('text-sm leading-tight font-mono', 't-body')).toBe('t-body');
    expect(cn('font-sans text-xs text-muted', 't-small')).toBe('text-muted t-small');
  });
});
