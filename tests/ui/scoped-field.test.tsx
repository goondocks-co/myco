// @vitest-environment jsdom
/**
 * Tests for ScopedField's registry-derived scope flow.
 *
 * Scope is no longer passed as props — it flows from `scopePolicyForPath(path)`:
 * the home tier is the write target, and the Personal pill renders only when
 * the registry lists `local` in `overridableBy`.
 *
 * Path fixtures used:
 *  - `agent.model`     → home grove, overridableBy ['local']  (Personal pill)
 *  - `embedding.model` → home grove, overridableBy []         (no Personal pill)
 *
 * Covers:
 * 1. grove home + local override allowed + no override → "Save Personal" pill,
 *    clicking calls setField(path, effective, 'local')
 * 2. grove home + local override present → "Personal" badge + "Reset" → resetField
 * 3. registry locks the field (overridableBy []) → no pill rendered
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ---------- API + hook stubs ---------- */

const setFieldMock = vi.fn();
const resetFieldMock = vi.fn();
const promoteFieldMock = vi.fn();

// Stable hook return. Tests mutate these to control state.
const hookState = {
  effective: { agent: { model: 'claude-opus-4' } } as Record<string, unknown>,
  local: {} as Record<string, unknown>,
};

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => ({
    effective: hookState.effective,
    local: hookState.local,
    isLoading: false,
    isLocalOverride: (path: string) => {
      // Simple: check if hookState.local has the key at the top segment
      const top = path.split('.')[0] ?? path;
      return top in hookState.local;
    },
    setField: (...args: unknown[]) => setFieldMock(...args),
    setFields: vi.fn().mockResolvedValue(undefined),
    resetField: (...args: unknown[]) => resetFieldMock(...args),
    promoteField: (...args: unknown[]) => promoteFieldMock(...args),
  }),
}));

mock.module('../../packages/myco/ui/src/components/config/restart-gate', () => ({
  useMarkRestartDirty: () => vi.fn(),
}));

// Import AFTER mocks
const { ScopedField } = await import('../../packages/myco/ui/src/components/config/ScopedField');

/* ---------- Wrapper ---------- */

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/* ---------- Helper render ---------- */

function renderScopedField(props: Record<string, unknown>) {
  return render(
    createElement(
      ScopedField,
      {
        path: 'agent.model',
        label: 'Model',
        ...props,
        children: ({ value }: { value: unknown }) =>
          createElement('input', {
            'data-testid': 'field-input',
            value: String(value ?? ''),
            readOnly: true,
          }),
      } as Parameters<typeof ScopedField>[0],
    ),
    { wrapper: makeWrapper() },
  );
}

/* ---------- Tests ---------- */

describe('ScopedField — grove home, Personal override allowed (agent.model)', () => {
  beforeEach(() => {
    setFieldMock.mockReset().mockResolvedValue(undefined);
    resetFieldMock.mockReset().mockResolvedValue(undefined);
    promoteFieldMock.mockReset().mockResolvedValue(undefined);

    hookState.effective = { agent: { model: 'claude-opus-4' } };
    hookState.local = {};
  });

  it('no local override: pill renders with "Save Personal" action', async () => {
    renderScopedField({});

    // The grove badge button should appear (pill renders always when local is overridable).
    // getByTitle would match both the button and the inner span; use getAllByTitle and
    // check at least one is a button with aria-haspopup.
    const groveTitledElements = screen.getAllByTitle(/grove/i);
    const pillTrigger = groveTitledElements.find((el) => el.getAttribute('aria-haspopup') === 'menu');
    expect(pillTrigger).toBeDefined();
  });

  it('no local override: clicking "Save Personal" calls setField with local scope', async () => {
    renderScopedField({});

    // Open the pill menu — button is the grove-home trigger
    const triggers = screen.getAllByRole('button');
    // Find the scope pill trigger (aria-haspopup="menu")
    const pillTrigger = triggers.find((b) => b.getAttribute('aria-haspopup') === 'menu');
    expect(pillTrigger).toBeDefined();

    fireEvent.click(pillTrigger!);

    const savePersonalBtn = screen.getByRole('menuitem', { name: /save personal/i });
    fireEvent.click(savePersonalBtn);

    await waitFor(() => {
      expect(setFieldMock).toHaveBeenCalledWith(
        'agent.model',
        'claude-opus-4',
        'local',
      );
    });
  });

  it('local override present: pill shows "Personal" badge and "Reset" action', async () => {
    hookState.local = { agent: { model: 'claude-haiku-4' } };
    renderScopedField({});

    // When a local override is present, the pill button shows "Personal" badge.
    // Both the button and the inner span carry the title, so use getAllByTitle
    // and find the button element (aria-haspopup="menu").
    const personalTitledEls = screen.getAllByTitle(/overridden on this machine/i);
    const pillTrigger = personalTitledEls.find((el) => el.getAttribute('aria-haspopup') === 'menu');
    expect(pillTrigger).toBeDefined();

    fireEvent.click(pillTrigger!);

    // Should have a "Reset" item
    const resetBtn = screen.getByRole('menuitem', { name: /reset/i });
    expect(resetBtn).toBeDefined();
  });

  it('local override present: clicking "Reset" calls resetField', async () => {
    hookState.local = { agent: { model: 'claude-haiku-4' } };
    renderScopedField({});

    const pillTrigger = screen.getAllByRole('button').find(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    );
    fireEvent.click(pillTrigger!);

    const resetBtn = screen.getByRole('menuitem', { name: /reset/i });
    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(resetFieldMock).toHaveBeenCalledWith('agent.model');
    });
  });
});

describe('ScopedField — registry locks the field (embedding.model: overridableBy [])', () => {
  beforeEach(() => {
    setFieldMock.mockReset().mockResolvedValue(undefined);
    resetFieldMock.mockReset().mockResolvedValue(undefined);
    promoteFieldMock.mockReset().mockResolvedValue(undefined);
    hookState.effective = { embedding: { model: 'bge-m3' } };
    hookState.local = {};
  });

  it('does not render any pill/promote/reset affordances when the policy disallows local', () => {
    renderScopedField({ path: 'embedding.model' });

    const menuButtons = screen.queryAllByRole('button', { name: /personal|save personal|reset|promote/i });
    expect(menuButtons).toHaveLength(0);

    // No pill trigger
    const pillTrigger = screen.queryAllByRole('button').find(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    );
    expect(pillTrigger).toBeUndefined();
  });

  it('does not render any pill even when a (stale) local override exists', () => {
    hookState.local = { embedding: { model: 'local-override' } };
    renderScopedField({ path: 'embedding.model' });

    const pillTrigger = screen.queryAllByRole('button').find(
      (b) => b.getAttribute('aria-haspopup') === 'menu',
    );
    expect(pillTrigger).toBeUndefined();
  });
});
