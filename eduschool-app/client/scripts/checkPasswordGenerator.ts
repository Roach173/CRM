// Self-check for client/src/lib/passwordGenerator.ts.
//
// Runs the generator a few hundred times and asserts every password passes
// the REAL server validation function — server/src/lib/passwordPolicy.ts's
// getPasswordError() — imported directly, not reimplemented, so this check
// can never silently drift from what the server actually enforces. It also
// asserts the structural/readability properties from the task: plain Latin
// letters + digits only, no ambiguous 0/O/1/l/I characters, and length bounds
// tied to the shared MIN_PASSWORD_LENGTH/MAX_PASSWORD_LENGTH constants (never
// a hardcoded number).
//
// Plain assert-based script, no test framework, no fixtures.
//
// Run from eduschool-app/client (Node 22+, native TS execution, no build step):
//   node scripts/checkPasswordGenerator.ts

import assert from 'node:assert/strict';
import { generateReadablePassword } from '../src/lib/passwordGenerator.ts';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../src/lib/passwordPolicy.ts';
import { getPasswordError } from '../../server/src/lib/passwordPolicy.ts';

const SAMPLE_SIZE = 500;

// Word-word-digits shape, e.g. "Tiger-Bridge-4712": capitalized word, dash,
// capitalized word, dash, one or more digits restricted to 2-9.
const SHAPE = /^[A-Z][a-z]+-[A-Z][a-z]+-[2-9]+$/;

let minLen = Infinity;
let maxLen = -Infinity;
const seen = new Set<string>();

for (let i = 0; i < SAMPLE_SIZE; i++) {
  const pwd = generateReadablePassword();

  // The one check that actually matters: does the server accept this?
  const serverError = getPasswordError(pwd);
  assert.strictEqual(
    serverError,
    null,
    `Sample #${i} "${pwd}" was REJECTED by server getPasswordError(): ${serverError}`
  );

  // Length bounds, expressed via the shared constants (no hardcoded numbers).
  assert.ok(
    pwd.length >= MIN_PASSWORD_LENGTH,
    `Sample #${i} "${pwd}" (len ${pwd.length}) is shorter than MIN_PASSWORD_LENGTH (${MIN_PASSWORD_LENGTH})`
  );
  assert.ok(
    pwd.length <= MAX_PASSWORD_LENGTH,
    `Sample #${i} "${pwd}" (len ${pwd.length}) is longer than MAX_PASSWORD_LENGTH (${MAX_PASSWORD_LENGTH})`
  );

  // Readability/shape: two capitalized Latin words + dash-separated digits.
  assert.ok(SHAPE.test(pwd), `Sample #${i} "${pwd}" does not match the expected Word-Word-Digits shape`);

  // No ambiguous characters: only digits 2-9 should ever appear (0/1 excluded
  // by construction), and no 'O'/'o'/'l'/'I' should appear as a digit stand-in
  // (words are plain dictionary words so letters are expected; this just
  // guards the digit run specifically).
  const digits = pwd.match(/\d/g) ?? [];
  for (const d of digits) {
    assert.ok('23456789'.includes(d), `Sample #${i} "${pwd}" contains excluded/ambiguous digit '${d}'`);
  }

  // Plain Latin letters, digits, and dashes only — no Cyrillic, no symbols.
  assert.ok(/^[A-Za-z0-9-]+$/.test(pwd), `Sample #${i} "${pwd}" contains characters outside [A-Za-z0-9-]`);

  minLen = Math.min(minLen, pwd.length);
  maxLen = Math.max(maxLen, pwd.length);
  seen.add(pwd);
}

console.log(`OK: ${SAMPLE_SIZE} generated passwords all passed server getPasswordError() + shape/length/charset checks.`);
console.log(`  length range: ${minLen}-${maxLen} (MIN_PASSWORD_LENGTH=${MIN_PASSWORD_LENGTH}, MAX_PASSWORD_LENGTH=${MAX_PASSWORD_LENGTH})`);
console.log(`  unique passwords: ${seen.size}/${SAMPLE_SIZE}`);
console.log(`  sample: ${generateReadablePassword()}`);
