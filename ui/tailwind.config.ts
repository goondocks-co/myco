import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    fontFamily: {
      mono: 'var(--font-ui, ui-monospace, monospace)',
      sans: 'var(--font-ui, ui-monospace, monospace)',
      serif: "Georgia, 'Times New Roman', serif",
    },
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        /* Design system palette — sage / ochre / terracotta */
        sage: {
          DEFAULT: '#abcfb8',
          dark: '#7B9E89',
          muted: 'rgba(171, 207, 184, 0.15)',
          glow: 'rgba(171, 207, 184, 0.6)',
        },
        ochre: {
          DEFAULT: '#edbf7f',
          dark: '#D4A86A',
          muted: 'rgba(237, 191, 127, 0.15)',
          glow: 'rgba(237, 191, 127, 0.4)',
        },
        terracotta: {
          DEFAULT: '#ffb4a1',
          dark: '#B85C44',
          muted: 'rgba(255, 180, 161, 0.15)',
          glow: 'rgba(255, 180, 161, 0.4)',
        },
        surface: {
          DEFAULT: '#131313',
          container: '#1f2020',
          'container-high': '#2a2a2a',
          'container-highest': '#353535',
          bright: '#393939',
        },
        'on-surface': '#e5e2e1',
        outline: '#8b928c',
        'outline-variant': '#424843',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        'sage-glow': '0 0 10px rgba(171, 207, 184, 0.6)',
        'ochre-glow': '0 0 10px rgba(237, 191, 127, 0.4)',
        'terracotta-glow': '0 0 10px rgba(255, 180, 161, 0.4)',
      },
    },
  },
  plugins: [],
} satisfies Config;
