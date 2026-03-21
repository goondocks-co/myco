import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type FontOption = 'geist-mono' | 'system' | 'sf-mono' | 'fira-code' | 'jetbrains-mono';

interface FontContextValue {
  font: FontOption;
  setFont: (font: FontOption) => void;
}

const STORAGE_KEY = 'myco-ui-font';
const DEFAULT_FONT: FontOption = 'geist-mono';
const CSS_PROPERTY = '--font-ui';

const FONT_STACKS: Record<FontOption, string> = {
  'geist-mono': "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
  'system': "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  'sf-mono': "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace",
  'fira-code': "'Fira Code', 'Fira Mono', ui-monospace, monospace",
  'jetbrains-mono': "'JetBrains Mono', ui-monospace, monospace",
};

const VALID_FONTS = new Set<string>(Object.keys(FONT_STACKS));

const FontContext = createContext<FontContextValue | undefined>(undefined);

function getStoredFont(): FontOption {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && VALID_FONTS.has(stored)) {
    return stored as FontOption;
  }
  return DEFAULT_FONT;
}

function applyFont(font: FontOption): void {
  document.documentElement.style.setProperty(CSS_PROPERTY, FONT_STACKS[font]);
}

export function FontProvider({ children }: { children: ReactNode }) {
  const [font, setFontState] = useState<FontOption>(getStoredFont);

  const setFont = (next: FontOption) => {
    localStorage.setItem(STORAGE_KEY, next);
    setFontState(next);
  };

  useEffect(() => {
    applyFont(font);
  }, [font]);

  return (
    <FontContext.Provider value={{ font, setFont }}>
      {children}
    </FontContext.Provider>
  );
}

export function useFont(): FontContextValue {
  const ctx = useContext(FontContext);
  if (!ctx) {
    throw new Error('useFont must be used within a FontProvider');
  }
  return ctx;
}

export type { FontOption };
