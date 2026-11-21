import { describe, it, expect } from 'vitest';
import { safeUrl } from './Help';

// Security contract: owner-authored topic URLs render on the shared /help page,
// so only http(s) may become a link — anything else must be neutralized.
describe('safeUrl (Help page XSS guard)', () => {
  it('passes http(s) URLs (trimmed)', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com');
    expect(safeUrl('http://example.com')).toBe('http://example.com');
    expect(safeUrl('  https://example.com  ')).toBe('https://example.com');
    expect(safeUrl('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM');
  });

  it('rejects dangerous / non-http schemes and empties', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('  javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>')).toBeNull();
    expect(safeUrl('/relative/path')).toBeNull();
    expect(safeUrl('example.com')).toBeNull();
    expect(safeUrl('')).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});
