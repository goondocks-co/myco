const PENDING_DEVICE_KEY = 'myco-pending-device';

/** The human code survives GitHub sign-in in this tab; it cannot redeem a machine credential. */
export function pendingDeviceCode(value?: string | null): string | null {
  try {
    if (value === null) window.sessionStorage.removeItem(PENDING_DEVICE_KEY);
    else if (value !== undefined) window.sessionStorage.setItem(PENDING_DEVICE_KEY, value);
    return window.sessionStorage.getItem(PENDING_DEVICE_KEY);
  } catch {
    return value ?? null;
  }
}
