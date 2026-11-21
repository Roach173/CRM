import { describe, expect, it } from 'vitest';
import { scKey, sessionKey } from './scheduleKeys';

describe('scKey', () => {
  it('builds a "day-slot" cell key', () => {
    expect(scKey(2, 5)).toBe('2-5');
  });
});

describe('sessionKey', () => {
  it('builds a "blockId_date" key', () => {
    expect(sessionKey(42, '2026-07-04')).toBe('42_2026-07-04');
  });
});
