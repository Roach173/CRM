import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

const sentryPlugin =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? [sentryVitePlugin({ org: process.env.SENTRY_ORG, project: process.env.SENTRY_PROJECT })]
    : [];

export default defineConfig(({ command }) => ({
  plugins: [react(), ...sentryPlugin],
  // Strip all console.* and debugger from production bundles; errors still reach
  // Sentry via AppErrorBoundary. Dev keeps full console output.
  esbuild: {
    drop: command === 'build' ? (['console', 'debugger'] as ('console' | 'debugger')[]) : [],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Allow ngrok free-tier tunnel hosts (e.g. *.ngrok-free.dev) to reach the dev server.
    allowedHosts: ['.ngrok-free.dev'],
    proxy: {
      '/api/v1': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      // Uploaded branding images (logo, hero photo) — resolveUploadUrl() in lib/api.ts
      // returns a bare "/uploads/..." path when VITE_API_URL is unset (normal local dev),
      // so it needs the same proxy treatment as /api/v1 or the browser requests it from
      // the Vite dev server itself instead of the API.
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  // `vite preview` (production build) does NOT inherit `server.*`, so it needs its own
  // allowedHosts + proxy. Serving the prod build over ngrok (port 4173) instead of the dev
  // server is the biggest mobile-perf win: minified, bundled, React in production mode.
  preview: {
    allowedHosts: ['.ngrok-free.dev', 'eduschool-client-production.up.railway.app', 'shamdan.kg', 'www.shamdan.kg'],
    proxy: {
      '/api/v1': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      // Uploaded branding images (logo, hero photo) — resolveUploadUrl() in lib/api.ts
      // returns a bare "/uploads/..." path when VITE_API_URL is unset (normal local dev),
      // so it needs the same proxy treatment as /api/v1 or the browser requests it from
      // the Vite dev server itself instead of the API.
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  test: {
    // Default stays 'node' — fast for the existing pure-logic tests. Component
    // tests opt into jsdom individually via a `// @vitest-environment jsdom`
    // comment at the top of the file.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    setupFiles: ['./src/vitest.setup.ts'],
  },
  build: {
    sourcemap: !!process.env.SENTRY_AUTH_TOKEN,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react/jsx-runtime'],
          'vendor-router': ['react-router'],
          'vendor-charts': ['recharts'],
          'vendor-xlsx': ['xlsx'],
          'vendor-webauthn': ['@simplewebauthn/browser'],
          // Animation libs are only used by the (now lazy) marketing Landing page.
          'vendor-motion': ['framer-motion'],
        },
      },
    },
  },
}));
