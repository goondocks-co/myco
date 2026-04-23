import { expect } from 'bun:test';
// jest-dom calls `expect.extend(...)` against the global `expect`. bun:test
// doesn't expose one by default, so plumb it through before importing the
// matcher bundle.
(globalThis as unknown as { expect: typeof expect }).expect = expect;
await import('@testing-library/jest-dom');

if (typeof window !== 'undefined') {
  const storage = new Map<string, string>();

  const localStorageMock = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, String(value));
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };

  Object.defineProperty(window, 'localStorage', {
    writable: true,
    value: localStorageMock,
  });

  Object.defineProperty(globalThis, 'localStorage', {
    writable: true,
    value: localStorageMock,
  });

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
