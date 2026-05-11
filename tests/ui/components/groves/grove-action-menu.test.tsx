// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../../../helpers/vi-shim.js';

/* ---------- jsdom polyfills ---------- */
class MutationObserverStub {
  observe(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] { return []; }
}
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const _g = globalThis as unknown as Record<string, unknown>;
if (typeof _g.MutationObserver === 'undefined') _g.MutationObserver = MutationObserverStub;
if (typeof _g.ResizeObserver === 'undefined') _g.ResizeObserver = ResizeObserverStub;
if (typeof _g.NodeFilter === 'undefined' && typeof document !== 'undefined') {
  const win = document.defaultView as unknown as Record<string, unknown> | null;
  if (win && win.NodeFilter) _g.NodeFilter = win.NodeFilter;
}

import { GroveActionMenu } from '../../../../packages/myco/ui/src/components/groves/GroveActionMenu';

function openMenu(groveName: string): void {
  const trigger = screen.getByRole('button', { name: `${groveName} actions` });
  fireEvent.click(trigger);
}

describe('GroveActionMenu', () => {
  let onRename: ReturnType<typeof vi.fn>;
  let onDelete: ReturnType<typeof vi.fn>;
  let onSetDefault: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onRename = vi.fn();
    onDelete = vi.fn();
    onSetDefault = vi.fn();
  });

  it('shows a Set as default item that fires onSetDefault when clicked', () => {
    render(
      <GroveActionMenu
        groveName="Personal"
        projectCount={0}
        isDefault={false}
        onRename={onRename}
        onDelete={onDelete}
        onSetDefault={onSetDefault}
      />,
    );
    openMenu('Personal');
    const item = screen.getByRole('menuitem', { name: 'Set as default' }) as HTMLButtonElement;
    expect(item).toBeDefined();
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    expect(onSetDefault).toHaveBeenCalledTimes(1);
  });

  it('disables Set as default when the Grove is already the default', () => {
    render(
      <GroveActionMenu
        groveName="Personal"
        projectCount={0}
        isDefault
        onRename={onRename}
        onDelete={onDelete}
        onSetDefault={onSetDefault}
      />,
    );
    openMenu('Personal');
    const item = screen.getByRole('menuitem', { name: 'Set as default' }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    fireEvent.click(item);
    expect(onSetDefault).not.toHaveBeenCalled();
  });
});
