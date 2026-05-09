import { expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// jest-dom calls `expect.extend(...)` against the global `expect`. bun:test
// doesn't expose one by default, so plumb it through before importing the
// matcher bundle.
(globalThis as unknown as { expect: typeof expect }).expect = expect;
await import('@testing-library/jest-dom');

// Sandbox MYCO_HOME for the duration of the test process so loadMergedConfig
// can't read the developer's real ~/.myco/groves/<id>/grove.yaml. Tests that
// explicitly override MYCO_HOME continue to win — this only kicks in when no
// caller has set it. Without this, the new three-tier config loader bleeds
// real Grove config into tests that touch loadMergedConfig.
if (!process.env.MYCO_HOME) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-home-'));
  process.env.MYCO_HOME = sandbox;
}

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
