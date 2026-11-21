// Single source of truth for browser origins allowed to talk to the API —
// used by the CORS config and by the CSRF origin check on cookie-only routes.
export const ALLOWED_ORIGINS = [
  process.env.CLIENT_URL || 'http://localhost:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
];
