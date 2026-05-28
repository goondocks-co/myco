// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';

const setFieldMock = vi.fn();
const effectiveAppearance = {
  theme: 'sage',
  mode: 'dark',
  font: 'default',
  density: 'normal',
};

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => ({
    effective: { appearance: effectiveAppearance },
    setField: setFieldMock,
  }),
}));

const { AppearanceProvider } = await import('../../packages/myco/ui/src/providers/appearance');
const { AppearanceSection } = await import('../../packages/myco/ui/src/layout/AppearanceSection');

describe('AppearanceSection', () => {
  beforeEach(() => {
    setFieldMock.mockReset();
    setFieldMock.mockResolvedValue(undefined);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    localStorage.clear();
  });

  it('labels appearance controls as Grove-scoped', () => {
    render(
      <AppearanceProvider>
        <AppearanceSection collapsed={false} />
      </AppearanceProvider>,
    );

    expect(screen.getAllByText('Grove')).toHaveLength(4);
    expect(screen.queryByText('Project')).toBeNull();
    expect(screen.queryByText('Personal')).toBeNull();
  });

  it('writes changes through the Grove-owned appearance setter', () => {
    render(
      <AppearanceProvider>
        <AppearanceSection collapsed={false} />
      </AppearanceProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Plum' }));

    expect(setFieldMock).toHaveBeenCalledWith('appearance.theme', 'plum', 'grove');
  });
});
