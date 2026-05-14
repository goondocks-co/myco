// @vitest-environment jsdom

import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { MasterDetailSplit } from '../../packages/myco/ui/src/components/ui/master-detail-split';

type Listener = (e: MediaQueryListEvent) => void;

function installMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  // @ts-expect-error — test scaffold
  globalThis.window.matchMedia = mock((q: string) => ({
    matches,
    media: q,
    onchange: null,
    addEventListener: (_t: 'change', l: Listener) => listeners.add(l),
    removeEventListener: (_t: 'change', l: Listener) => listeners.delete(l),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }));
}

afterEach(() => {
  // jsdom defines window.matchMedia as non-configurable once assigned, so
  // reset rather than delete.
  // @ts-expect-error — test scaffold
  globalThis.window.matchMedia = undefined;
});

describe('MasterDetailSplit', () => {
  it('renders both panes on desktop (matchMedia true)', () => {
    installMatchMedia(true);
    render(
      <MasterDetailSplit
        hasSelection={false}
        master={<div data-testid="m">master</div>}
        detail={<div data-testid="d">detail</div>}
      />,
    );
    expect(screen.getByTestId('m')).toBeDefined();
    expect(screen.getByTestId('d')).toBeDefined();
  });

  it('renders only master on mobile when no selection', () => {
    installMatchMedia(false);
    render(
      <MasterDetailSplit
        hasSelection={false}
        master={<div data-testid="m">master</div>}
        detail={<div data-testid="d">detail</div>}
      />,
    );
    expect(screen.getByTestId('m')).toBeDefined();
    expect(screen.queryByTestId('d')).toBeNull();
  });

  it('renders only detail on mobile when hasSelection', () => {
    installMatchMedia(false);
    render(
      <MasterDetailSplit
        hasSelection
        master={<div data-testid="m">master</div>}
        detail={<div data-testid="d">detail</div>}
      />,
    );
    expect(screen.queryByTestId('m')).toBeNull();
    expect(screen.getByTestId('d')).toBeDefined();
  });

  it('renders back-link header on mobile when onCloseMobileDetail provided', () => {
    installMatchMedia(false);
    const onClose = mock(() => {});
    render(
      <MasterDetailSplit
        hasSelection
        onCloseMobileDetail={onClose}
        master={<div>master</div>}
        detail={<div>detail</div>}
      />,
    );
    const back = screen.getByRole('button', { name: /back/i });
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits back-link when onCloseMobileDetail is not provided', () => {
    installMatchMedia(false);
    render(
      <MasterDetailSplit
        hasSelection
        master={<div>master</div>}
        detail={<div>detail</div>}
      />,
    );
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
  });
});
