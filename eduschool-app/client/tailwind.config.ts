import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background:         'rgb(var(--color-background) / <alpha-value>)',
        card:               'rgb(var(--color-card) / <alpha-value>)',
        primary: {
          DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)',
          dim:     'rgb(var(--color-primary-dim) / <alpha-value>)',
          dark:    'rgb(var(--color-primary-dark) / <alpha-value>)',
        },
        primaryContainer:   'rgb(var(--color-primary-container) / <alpha-value>)',
        onPrimaryContainer: 'rgb(var(--color-on-primary-container) / <alpha-value>)',
        border:             'rgb(var(--color-border) / <alpha-value>)',
        surface:            'rgb(var(--color-surface) / <alpha-value>)',
        surfaceLow:         'rgb(var(--color-surface-low) / <alpha-value>)',
        surfaceLowest:      'rgb(var(--color-surface-lowest) / <alpha-value>)',
        textPrimary:        'rgb(var(--color-text-primary) / <alpha-value>)',
        textSecondary:      'rgb(var(--color-text-secondary) / <alpha-value>)',
        danger: '#e63946',
        warning: '#f4a261',
        frozen: '#0284C7',
        success: '#2a9d8f',
        'lesson-present':   '#d1fae5',
        'lesson-absent':    '#fee2e2',
        'lesson-late':      '#fef9c3',
        'lesson-cancelled': '#f1f5f9',
        'lesson-substitute':'#ede9fe',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        serif: ['Noto Serif', 'serif'],
      },
      fontSize: {
        'display-xl': ['2.5rem', { lineHeight: '1.2', fontWeight: '700' }],
        'display-lg': ['2rem', { lineHeight: '1.25', fontWeight: '700' }],
        'heading-xl': ['1.75rem', { lineHeight: '1.3', fontWeight: '600' }],
        'heading-lg': ['1.5rem', { lineHeight: '1.35', fontWeight: '600' }],
        'heading-md': ['1.25rem', { lineHeight: '1.4', fontWeight: '600' }],
        'heading-sm': ['1.0625rem', { lineHeight: '1.45', fontWeight: '600' }],
        'body-lg':    ['1rem', { lineHeight: '1.6' }],
        'body-md':    ['0.9375rem', { lineHeight: '1.6' }],
        'body-sm':    ['0.875rem', { lineHeight: '1.55' }],
        caption:      ['0.75rem', { lineHeight: '1.5' }],
      },
      borderRadius: {
        DEFAULT: '12px',
        lg: '16px'
      },
      keyframes: {
        'slide-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'scale(0.95) translateY(-4px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
      },
      animation: {
        'slide-up': 'slide-up 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
        'fade-in': 'fade-in 0.15s ease-out',
      },
      zIndex: {
        dropdown: '10',
        sticky: '20',
        overlay: '30',
        drawer: '40',
        modal: '1000',
        toast: '60',
        tooltip: '70',
      },
    },
  },
  plugins: [],
} satisfies Config;
