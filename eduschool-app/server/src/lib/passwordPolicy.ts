// Single source of truth for password requirements — shared by every place that
// creates or resets a User password (self-registration, admin-created students/
// teachers, invites, password reset).
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 72; // bcrypt silently ignores bytes beyond 72 — reject instead of truncating

// Deliberately short list of the passwords most likely to satisfy only the length
// check. Not a breach-database lookup — that needs an external service — just a
// floor against the most obvious cases.
const COMMON_PASSWORDS = new Set([
  'password123', 'password1234',
  'qwerty123456', 'qwertyuiop12',
  '123456789012', 'admin12345678',
  'letmein12345', 'welcome12345',
  'iloveyou1234', 'changeme1234',
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

export function getPasswordError(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Пароль слишком длинный (максимум ${MAX_PASSWORD_LENGTH} символов)`;
  }
  if (isCommonPassword(password)) {
    return 'Этот пароль слишком распространён, выберите другой';
  }
  return null;
}

export function isPasswordTooShort(password: unknown): boolean {
  return getPasswordError(password) !== null;
}
