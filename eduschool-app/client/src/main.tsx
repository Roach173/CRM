import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppErrorBoundary } from './components/ui/ErrorBoundary';
import './index.css';

const sentryEnabled = Boolean(import.meta.env.VITE_SENTRY_DSN);

if (sentryEnabled) {
  void import('./lib/sentry').then(m => m.initSentry());
}

// Install-only SW (see public/sw.js) — no API/data caching, production only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>
  );
}
