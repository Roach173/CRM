import { createLogger } from './logger';

const log = createLogger('jwtSecret');
const DEV_FALLBACK = 'dev-jwt-secret-not-for-production';

// Single source of truth for the access-token lifetime — every route that issues
// a Bearer token (login, register, google, refresh, 2FA verify, invite-accept)
// must use this, not its own literal. Discovered via manual QA: auth.ts had been
// updated to 15m while invites.ts and 2fa.ts were still separately hardcoding 7d.
export const ACCESS_TOKEN_TTL = '15m';

/**
 * Returns the JWT signing secret.
 * In production: throws (via process.exit) if JWT_SECRET is not configured.
 * In development/test: returns a clearly-labelled insecure fallback so tests run without env setup.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      // Startup validation in index.ts should have caught this already.
      // This is a defense-in-depth check — fail loudly rather than use an empty/default secret.
      log.fatal('JWT_SECRET is not set — refusing to authenticate requests in production');
      process.exit(1);
    }
    return DEV_FALLBACK;
  }
  return secret;
}
