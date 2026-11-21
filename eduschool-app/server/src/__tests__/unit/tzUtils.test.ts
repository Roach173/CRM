/**
 * Unit tests for buildSessionStart.
 * Verifies timezone-correct combination of UTC-noon sessionDate + "HH:mm" startTime.
 */
import { buildSessionStart } from '../../lib/tzUtils';

// All sessionDates stored as UTC noon (timezone-safe sentinel)
const JUN_15_NOON_UTC = new Date('2026-06-15T12:00:00.000Z');

describe('buildSessionStart', () => {
  it('Bishkek (UTC+6), 09:00 → T03:00Z', () => {
    const result = buildSessionStart(JUN_15_NOON_UTC, '09:00', 'Asia/Bishkek');
    expect(result.toISOString()).toBe('2026-06-15T03:00:00.000Z');
  });

  it('Bishkek (UTC+6), 20:00 → T14:00Z', () => {
    const result = buildSessionStart(JUN_15_NOON_UTC, '20:00', 'Asia/Bishkek');
    expect(result.toISOString()).toBe('2026-06-15T14:00:00.000Z');
  });

  it('UTC, 12:00 → T12:00Z (coincides with noon sentinel)', () => {
    const result = buildSessionStart(JUN_15_NOON_UTC, '12:00', 'UTC');
    expect(result.toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });

  it('New York (UTC-5 in June = UTC-4 DST), 09:00 → T13:00Z', () => {
    const result = buildSessionStart(JUN_15_NOON_UTC, '09:00', 'America/New_York');
    // June = EDT (UTC-4), so 09:00 New York = T13:00Z
    expect(result.toISOString()).toBe('2026-06-15T13:00:00.000Z');
  });

  it('Tokyo (UTC+9), 08:00 → T23:00Z prev day', () => {
    const result = buildSessionStart(JUN_15_NOON_UTC, '08:00', 'Asia/Tokyo');
    // 08:00 Tokyo = T23:00Z June 14
    expect(result.toISOString()).toBe('2026-06-14T23:00:00.000Z');
  });

  it('London (UTC+1 BST in June), 10:00 → T09:00Z', () => {
    const result = buildSessionStart(JUN_15_NOON_UTC, '10:00', 'Europe/London');
    expect(result.toISOString()).toBe('2026-06-15T09:00:00.000Z');
  });
});
