// Generates readable, pronounceable temporary passwords for admin-created users
// (e.g. the "Новый студент" modal), instead of gibberish nobody can read aloud
// or retype from a phone screen.
//
// Explicit ".ts" extension on this relative import (supported here via
// tsconfig's `allowImportingTsExtensions`) so this module can also be executed
// directly by Node's native TypeScript support with no bundler — see
// client/scripts/checkPasswordGenerator.ts, which runs this exact file.
import { MIN_PASSWORD_LENGTH } from './passwordPolicy.ts';

// Short, hand-picked list of plain English nouns, 4+ letters, capitalized. None
// start with 'I' or 'O' — those are visually close to the digits 1/0 when a
// generated password is read aloud or copied from a screen. Kept short and
// inline on purpose (no dependency, no corpus file).
const WORDS = [
  'Tiger', 'River', 'Bridge', 'Castle', 'Forest', 'Garden', 'Harbor', 'Jungle',
  'Meadow', 'Palace', 'Rocket', 'Silver', 'Sunset', 'Thunder', 'Valley', 'Winter',
  'Amber', 'Coral', 'Delta', 'Ember', 'Falcon', 'Golden', 'Hazel', 'Jasper',
  'Maple', 'Nectar', 'Panda', 'Quartz', 'Ruby', 'Storm', 'Tulip', 'Velvet',
  'Willow', 'Zebra', 'Eagle', 'Dragon', 'Comet', 'Canyon', 'Desert', 'Ginger',
];

// Digits only — excludes '0' and '1', the two most commonly misread/mistyped
// against the letters O/o and l/I when a password is dictated or transcribed.
const DIGITS = '23456789';
const SEPARATOR = '-';

/** Cryptographically-secure, unbiased random integer in [0, maxExclusive). */
function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error('maxExclusive must be a positive integer');
  }
  const buffer = new Uint32Array(1);
  // Reject draws that fall in the last, incomplete slice of the 32-bit range so
  // every remaining outcome has exactly equal probability (no modulo bias).
  const rejectionCeiling = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= rejectionCeiling);
  return value % maxExclusive;
}

function randomWord(excluding?: string): string {
  let word = WORDS[secureRandomInt(WORDS.length)];
  while (word === excluding) {
    word = WORDS[secureRandomInt(WORDS.length)];
  }
  return word;
}

function randomDigits(count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += DIGITS[secureRandomInt(DIGITS.length)];
  }
  return out;
}

/**
 * Generates a readable password: two different capitalized words joined by
 * '-' plus a run of digits, e.g. "Tiger-Bridge-4712".
 *
 * Guaranteed to pass server/src/lib/passwordPolicy.ts's getPasswordError():
 *  - Length >= MIN_PASSWORD_LENGTH: two words (4+ letters each) + separator +
 *    4 digits is already well past the current minimum (12); the digit run
 *    grows automatically until the shared constant is satisfied, so this stays
 *    correct even if MIN_PASSWORD_LENGTH is raised later. No length number is
 *    hardcoded here.
 *  - Length <= MAX_PASSWORD_LENGTH (72): far below it in every case.
 *  - Not in the common-password blocklist: every blocklisted entry is a bare
 *    lowercase letters+digits run with no separator, so a "Word-Word-####"
 *    shaped password can never collide with one, by construction.
 */
export function generateReadablePassword(): string {
  const word1 = randomWord();
  const word2 = randomWord(word1);

  let digitCount = 4;
  let password = `${word1}${SEPARATOR}${word2}${SEPARATOR}${randomDigits(digitCount)}`;
  while (password.length < MIN_PASSWORD_LENGTH) {
    digitCount += 1;
    password = `${word1}${SEPARATOR}${word2}${SEPARATOR}${randomDigits(digitCount)}`;
  }
  return password;
}
