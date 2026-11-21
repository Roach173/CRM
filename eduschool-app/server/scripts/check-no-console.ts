/**
 * Fails when app code under src/ uses console.* instead of the pino logger
 * (lib/logger.ts createLogger). Console output bypasses JSON structure,
 * log levels, and the requestId/schoolId/userId context mixin.
 *
 * Excluded: src/scripts/ and src/__tests__/ (CLI/test output is legitimate),
 * .mjs self-checks, and lines carrying a `no-console-ok` marker (pre-boot fatals).
 */
import fs from 'fs';
import path from 'path';

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const CONSOLE_RE = /\bconsole\.(log|error|warn|info|debug)\s*\(/;

const violations: string[] = [];

function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'scripts' || entry.name === '__tests__') continue;
      walk(full);
    } else if (entry.name.endsWith('.ts')) {
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (CONSOLE_RE.test(line) && !line.includes('no-console-ok')) {
          violations.push(`${path.relative(SRC_DIR, full)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
  }
}

walk(SRC_DIR);

if (violations.length > 0) {
  console.error(`console.* usage found in app code (${violations.length}):\n`);
  for (const v of violations) console.error('  ' + v);
  console.error('\nUse createLogger from src/lib/logger instead, e.g. log.error({ err }, \'context message\').');
  console.error('For intentional pre-boot output, append a `// no-console-ok` marker.');
  process.exit(1);
}

console.log('no-console check passed — all app code uses the pino logger.');
