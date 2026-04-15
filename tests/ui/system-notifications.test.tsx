// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemNotifications } from '../../packages/myco/ui/src/components/notifications/SystemNotifications';

const useNotificationsMock = vi.fn();
const useScopedConfigMock = vi.fn();

vi.mock('../../packages/myco/ui/src/hooks/use-notifications', () => ({
  useLiveNotifications: () => useNotificationsMock(),
}));

vi.mock('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => useScopedConfigMock(),
}));

describe('SystemNotifications', () => {
  beforeEach(() => {
    useNotificationsMock.mockReset();
    useScopedConfigMock.mockReset();
    useScopedConfigMock.mockReturnValue({
      effective: {
        notifications: {
          system_notifications: true,
        },
      },
    });
  });

  it('refetches banner notifications when the window loses focus', () => {
    const refetch = vi.fn();
    useNotificationsMock.mockReturnValue({
      data: { items: [] },
      refetch,
    });

    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'granted' },
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    render(<SystemNotifications />);
    window.dispatchEvent(new Event('blur'));

    expect(refetch).toHaveBeenCalled();
  });
});
