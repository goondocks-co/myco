import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type FontOption = 'default' | 'geist-mono' | 'system' | 'sf-mono' | 'fira-code' | 'jetbrains-mono';

interface FontContextValue {
  font: FontOption;
  setFont: (font: FontOption) => void;
}

const STORAGE_KEY = 'myco-ui-font';
const DEFAULT_FONT: FontOption = 'default';

interface FontStack {
  heading: string;
  ui: string;
  data: string;
}

const FONT_STACKS: Record<FontOption, FontStack> = {
  'default': {
    heading: "'Newsreader', Georgia, serif",
    ui: "'Inter', system-ui, sans-serif",
    data: "'JetBrains Mono', 'Fira Code', monospace",
  },
  'geist-mono': {
    heading: "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
    ui: "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
    data: "'Geist Mono', 'SF Mono', 'Fira Code', monospace",
  },
  'system': {
    heading: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    ui: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    data: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  },
  'sf-mono': {
    heading: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace",
    ui: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace",
    data: "'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace",
  },
  'fira-code': {
    heading: "'Fira Code', 'Fira Mono', ui-monospace, monospace",
    ui: "'Fira Code', 'Fira Mono', ui-monospace, monospace",
    data: "'Fira Code', 'Fira Mono', ui-monospace, monospace",
  },
  'jetbrains-mono': {
    heading: "'JetBrains Mono', ui-monospace, monospace",
    ui: "'JetBrains Mono', ui-monospace, monospace",
    data: "'JetBrains Mono', ui-monospace, monospace",
  },
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
  const stack = FONT_STACKS[font];
  const root = document.documentElement.style;
  root.setProperty('--font-heading', stack.heading);
  root.setProperty('--font-ui', stack.ui);
  root.setProperty('--font-data', stack.data);
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
