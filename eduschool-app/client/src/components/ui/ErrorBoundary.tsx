import React from 'react';
import { ErrorBoundary, FallbackProps } from 'react-error-boundary';

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <h2 className="text-xl font-semibold text-foreground">Что-то пошло не так</h2>
        <p className="text-sm text-muted-foreground">Попробуйте перезагрузить страницу или обратитесь в поддержку.</p>
        {import.meta.env.DEV && (
          <pre className="text-left text-xs bg-red-50 text-red-700 p-4 rounded-lg overflow-auto max-h-48 border border-red-200">
            {error.message}
            {error.stack ? '\n' + error.stack : ''}
          </pre>
        )}
        <button
          onClick={resetErrorBoundary}
          className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary/90 transition-colors"
        >
          Перезагрузить
        </button>
      </div>
    </div>
  );
}

interface AppErrorBoundaryProps {
  children: React.ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

export function AppErrorBoundary({ children, onError }: AppErrorBoundaryProps) {
  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error, info) => {
        // Report from the boundary itself so every usage (root + route-level) reaches Sentry
        if (import.meta.env.VITE_SENTRY_DSN) {
          void import('../../lib/sentry').then(m => m.captureException(error));
        }
        onError?.(error, info);
      }}
      onReset={() => window.location.reload()}
    >
      {children}
    </ErrorBoundary>
  );
}
