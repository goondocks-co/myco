// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';

let setFieldMock = vi.fn();
let effectiveAppearance = {
  theme: 'sage',
  mode: 'dark',
  font: 'default',
  density: 'normal',
};

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useIsTeamConfigTarget: () => false,
  useScopedConfig: () => ({
    effective: { appearance: effectiveAppearance },
    setField: setFieldMock,
  }),
}));

const { AppearanceProvider, useAppearance } = await import(
  '../../packages/myco/ui/src/providers/appearance'
);

function Probe() {
  const { set } = useAppearance();
  return (
    <button type="button" onClick={() => { void set('font', 'jetbrains-mono'); }}>
      Set font
    </button>
  );
}

describe('AppearanceProvider', () => {
  beforeEach(() => {
    setFieldMock = vi.fn(() => new Promise(() => {}));
    effectiveAppearance = {
      theme: 'sage',
      mode: 'dark',
      font: 'default',
      density: 'normal',
    };
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    localStorage.clear();
  });

  it('applies appearance optimistically and writes the Grove tier', async () => {
    render(
      <AppearanceProvider>
        <Probe />
      </AppearanceProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set font' }));

    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('JetBrains Mono');
    await waitFor(() => {
      expect(setFieldMock).toHaveBeenCalledWith('appearance.font', 'jetbrains-mono', 'grove');
    });
  });

  it('applies fetched Grove appearance to the document on mount', () => {
    effectiveAppearance = {
      theme: 'plum',
      mode: 'light',
      font: 'jetbrains-mono',
      density: 'compact',
    };

    render(
      <AppearanceProvider>
        <div />
      </AppearanceProvider>,
    );

    expect(document.documentElement.dataset.theme).toBe('plum');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('JetBrains Mono');
    expect(document.documentElement.style.getPropertyValue('--density')).toBe('0.85');
    expect(localStorage.getItem('myco-appearance')).toContain('"theme":"plum"');
  });
});
