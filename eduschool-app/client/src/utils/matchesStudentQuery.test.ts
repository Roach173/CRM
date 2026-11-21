import { describe, expect, it } from 'vitest';
import { matchesStudentQuery } from './scheduleUtils';

// SlotPanel filters GROUPS with this; GroupRow filters STUDENTS with it. They must
// stay the same predicate — a divergence shows up as a group that expands onto an
// empty roster, which reads to the user as lost students.
const roster = [
  { n: 'Адам Бейли', em: 'adam@school.io' },
  { n: 'Ирина Данилов', em: 'irina@school.io' },
  { n: 'Георгий Йохансон', em: null },
];

describe('matchesStudentQuery', () => {
  it('an empty or whitespace query keeps the whole roster', () => {
    expect(roster.filter(s => matchesStudentQuery(s, ''))).toHaveLength(3);
    expect(roster.filter(s => matchesStudentQuery(s, '   '))).toHaveLength(3);
  });

  it('matches on name, case-insensitively and on a partial', () => {
    expect(roster.filter(s => matchesStudentQuery(s, 'адам')).map(s => s.n)).toEqual(['Адам Бейли']);
    expect(roster.filter(s => matchesStudentQuery(s, 'ЙОХАН')).map(s => s.n)).toEqual(['Георгий Йохансон']);
  });

  it('matches on email and survives a missing one', () => {
    expect(roster.filter(s => matchesStudentQuery(s, 'irina@')).map(s => s.n)).toEqual(['Ирина Данилов']);
    expect(() => matchesStudentQuery({ n: 'Без почты', em: null }, 'x')).not.toThrow();
  });

  it('a query nobody matches yields an empty list, not the full one', () => {
    expect(roster.filter(s => matchesStudentQuery(s, 'zzz'))).toHaveLength(0);
  });
});
