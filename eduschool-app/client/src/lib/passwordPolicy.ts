// Client-side mirror of server/src/lib/passwordPolicy.ts.
//
// The SERVER is the single source of truth for password validation
// (server/src/lib/passwordPolicy.ts::getPasswordError). This file exists only so
// client forms can show a length requirement and pre-validate consistently with
// what the server will actually accept — it must be kept in sync by hand if the
// server value ever changes. There is no shared/build-time module between
// client and server in this repo, so duplication here is intentional and minimal
// (see server/src/lib/passwordPolicy.ts for the additional common-password
// blocklist check, which is server-only and not duplicated here).
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 72;

/** Short hint for placeholders/help text, e.g. "Минимум 12 символов". */
export function passwordMinLengthHint(): string {
  return `Минимум ${MIN_PASSWORD_LENGTH} символов`;
}

/** Full sentence matching the server's getPasswordError() wording for a too-short password. */
export function passwordTooShortMessage(): string {
  return `Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов`;
}
