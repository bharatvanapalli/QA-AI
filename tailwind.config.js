/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
        // Display serif used by Overview V2 for the verdict word ("HOLD",
        // "GO"). Loaded via @import in index.css. Italic by default.
        display: [
          'Instrument Serif',
          'ui-serif',
          'Georgia',
          'Times New Roman',
          'serif',
        ],
      },
      fontSize: {
        // Tight, intentional scale
        '2xs': ['10.5px', { lineHeight: '14px', letterSpacing: '0.02em' }],
        xs:   ['12px',   { lineHeight: '16px' }],
        sm:   ['13px',   { lineHeight: '20px' }],
        base: ['14px',   { lineHeight: '22px' }],
        md:   ['15px',   { lineHeight: '22px' }],
        lg:   ['17px',   { lineHeight: '24px', letterSpacing: '-0.005em' }],
        xl:   ['19px',   { lineHeight: '26px', letterSpacing: '-0.01em' }],
        '2xl':['22px',   { lineHeight: '28px', letterSpacing: '-0.015em' }],
        '3xl':['28px',   { lineHeight: '34px', letterSpacing: '-0.02em' }],
        '4xl':['34px',   { lineHeight: '40px', letterSpacing: '-0.025em' }],
      },
      colors: {
        ink: {
          50:  '#f7f8fa',
          100: '#eef0f4',
          200: '#dfe3eb',
          300: '#c4cad6',
          400: '#9aa3b4',
          500: '#6b7384',
          600: '#4a5161',
          700: '#343a47',
          800: '#1f242d',
          900: '#0b1220',
        },
        // Status palette — full shade ranges so badges, banners, borders, and
        // dark-text-on-light-bg compositions can all be expressed without
        // falling back to raw slate/rose/emerald/amber/sky/violet tokens.
        success: {
          50: '#ecfdf3', 100: '#d1fadf', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399',
          500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b',
        },
        danger: {
          50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171',
          500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d',
        },
        warn: {
          50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24',
          500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f',
        },
        info: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa',
          500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a',
        },
        accent: {
          50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa',
          500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95',
        },
      },
      boxShadow: {
        // Layered, premium-feeling shadows
        card:        '0 1px 0 0 rgba(15, 23, 42, 0.04), 0 2px 4px -2px rgba(15, 23, 42, 0.06), 0 4px 8px -4px rgba(15, 23, 42, 0.06)',
        'card-hover':'0 1px 0 0 rgba(15, 23, 42, 0.04), 0 6px 12px -4px rgba(15, 23, 42, 0.10), 0 12px 24px -8px rgba(15, 23, 42, 0.08)',
        pop:         '0 6px 16px -4px rgba(15, 23, 42, 0.14), 0 16px 32px -12px rgba(15, 23, 42, 0.12)',
        ring:        '0 0 0 3px rgba(15, 23, 42, 0.08)',
        'ring-emerald': '0 0 0 3px rgba(16, 185, 129, 0.18)',
        'ring-rose':    '0 0 0 3px rgba(239, 68, 68, 0.18)',
      },
      borderRadius: {
        none: '0',
        sm:   '4px',
        DEFAULT: '6px',
        md:   '8px',
        lg:   '10px',
        xl:   '14px',
        '2xl':'18px',
        card: '12px',
        btn:  '8px',
        pill: '999px',
      },
      spacing: {
        // 4px-based scale already provided; add named utility tokens for layout rhythm
        gutter: '24px',
        page:   '32px',
      },
      transitionTimingFunction: {
        'out-soft': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
