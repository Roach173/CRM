/**
 * Tests for effective policy date logic:
 *   1. getNextMondayDateInTz   — always next Monday, never current week
 *   2. getFirstWorkingDateStr  — first active day starting from next Monday
 *   3. computePolicyImpact     — pure read, NEVER mutates sessions
 *   4. computePolicyImpact     — returns policyEffectiveFrom, firstWorkingDate, affectedBlockIds
 */
import {
  prisma, cleanDb, createSchool, createUser, createStaffProfile,
  createGroup, createBlock, createSession, createFinanceConfig,
} from '../helpers/testDb';
import { computePolicyImpact, getFirstWorkingDateStr } from '../../services/policyService';
import { getNextMondayDateInTz } from '../../lib/tzUtils';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nextSchemaDayDate(schemaDay: number): Date {
  const date = new Date();
  const currentSchemaDay = (date.getUTCDay() + 6) % 7;
  let delta = (schemaDay - currentSchemaDay + 7) % 7;
  if (delta === 0) delta = 7;
  date.setUTCDate(date.getUTCDate() + delta);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

async function setupImpactFixture(activeDays = [0, 1, 2, 3, 4]) {
  const school = await createSchool({
    timezone: 'UTC', activeDays, workStart: '09:00', workEnd: '18:00',
  });
  await createFinanceConfig(school.id);
  const tUser = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(tUser.id, school.id);
  const group = await createGroup(school.id);
  const block = await createBlock({
    groupId: group.id, schoolId: school.id, staffProfileId: staff.id,
    days: [0, 1, 2, 3, 4],
  });
  return { school, staff, group, block };
}

// ─── getNextMondayDateInTz ────────────────────────────────────────────────────

describe('getNextMondayDateInTz', () => {
  it('returns a Date whose getUTCDay() === 1 (Monday)', () => {
    const { date } = getNextMondayDateInTz('UTC');
    expect(date.getUTCDay()).toBe(1);
  });

  it('returns a date strictly after today midnight UTC', () => {
    const { date } = getNextMondayDateInTz('UTC');
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    expect(date.getTime()).toBeGreaterThan(todayMidnight.getTime());
  });

  it('returns a Monday no more than 8 days in the future', () => {
    const { date } = getNextMondayDateInTz('UTC');
    const eightDays = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(date.getTime()).toBeLessThan(eightDays.getTime());
  });

  it('dateStr matches the YYYY-MM-DD of the returned Date', () => {
    const { date, dateStr } = getNextMondayDateInTz('UTC');
    const pad = (n: number) => String(n).padStart(2, '0');
    const expected = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    expect(dateStr).toBe(expected);
  });

  it('Asia/Bishkek timezone: dateStr resolves to a Monday in local time', () => {
    // date (UTC) may be Sunday UTC because Bishkek midnight = prev UTC day.
    // The local dateStr must parse to Monday when treated as a local calendar date.
    const { dateStr } = getNextMondayDateInTz('Asia/Bishkek');
    const [y, m, d] = dateStr.split('-').map(Number);
    const asUtcMidnight = new Date(Date.UTC(y, m - 1, d));
    expect(asUtcMidnight.getUTCDay()).toBe(1); // JS: Mon=1
  });
});

// ─── getFirstWorkingDateStr ───────────────────────────────────────────────────

describe('getFirstWorkingDateStr', () => {
  // 2026-06-22 is a known Monday (UTC)
  const MONDAY = '2026-06-22';

  it('returns Monday when Mon (0) is included in activeDays', () => {
    expect(getFirstWorkingDateStr(MONDAY, [0, 1, 2, 3, 4])).toBe('2026-06-22');
  });

  it('returns Tuesday (2026-06-23) when Monday excluded, Tue (1) first', () => {
    expect(getFirstWorkingDateStr(MONDAY, [1, 2, 3, 4])).toBe('2026-06-23');
  });

  it('returns Wednesday (2026-06-24) when Mon+Tue excluded', () => {
    expect(getFirstWorkingDateStr(MONDAY, [2, 3, 4])).toBe('2026-06-24');
  });

  it('returns Saturday (2026-06-27) when only Sat (5) active', () => {
    expect(getFirstWorkingDateStr(MONDAY, [5])).toBe('2026-06-27');
  });

  it('returns Sunday (2026-06-28) when only Sun (6) active', () => {
    expect(getFirstWorkingDateStr(MONDAY, [6])).toBe('2026-06-28');
  });

  it('returns Monday as fallback when activeDays is empty', () => {
    expect(getFirstWorkingDateStr(MONDAY, [])).toBe(MONDAY);
  });
});

// ─── computePolicyImpact — no mutations ──────────────────────────────────────

describe('computePolicyImpact — NEVER mutates sessions (no-invalidate guarantee)', () => {
  it('does NOT invalidate sessions when activeDays is narrowed', async () => {
    const { school, staff, block } = await setupImpactFixture([0, 1, 2, 3, 4]);

    const monSession = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(0), status: 'UPCOMING', // Monday session
    });

    // Simulate what PATCH /settings does — read-only impact, no mutation
    await computePolicyImpact(school.id, { activeDays: [1, 2, 3, 4] }); // remove Monday

    const after = await prisma.lessonSession.findUnique({ where: { id: monSession.id } });
    expect(after!.status).toBe('UPCOMING'); // must remain UPCOMING — no mutation
  });

  it('does NOT invalidate sessions when workHours are narrowed', async () => {
    const { school, staff, block } = await setupImpactFixture([0, 1, 2, 3, 4]);

    const session = await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(0), status: 'UPCOMING', // 09:00-10:00
    });

    // Narrow work hours so 09:00 lesson is outside — still must not invalidate
    await computePolicyImpact(school.id, {
      activeDays: [0, 1, 2, 3, 4],
      workStart: '10:00',
      workEnd: '18:00',
    });

    const after = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(after!.status).toBe('UPCOMING'); // informational only — no write
  });

  it('counts sessions outside removed activeDays correctly', async () => {
    const { school, staff, block } = await setupImpactFixture([0, 1, 2, 3, 4]);

    await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(0), status: 'UPCOMING', // Monday → will be outside
    });
    await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(1), status: 'UPCOMING', // Tuesday → still inside
    });

    const impact = await computePolicyImpact(school.id, { activeDays: [1, 2, 3, 4] });

    expect(impact.sessionsOutsideDays).toBe(1);
    expect(impact.sessionsOutsideHours).toBe(0);
  });

  it('counts sessions outside work hours correctly', async () => {
    const { school, staff, block } = await setupImpactFixture([0, 1, 2, 3, 4]);

    await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(0), status: 'UPCOMING', // startTimeSnap=09:00
    });

    // Narrow to 10:00-18:00: 09:00 session is outside
    const impact = await computePolicyImpact(school.id, {
      activeDays: [0, 1, 2, 3, 4],
      workStart: '10:00',
      workEnd: '18:00',
    });

    expect(impact.sessionsOutsideHours).toBe(1);
    expect(impact.sessionsOutsideDays).toBe(0);
  });

  it('returns zero counts when everything fits the new policy', async () => {
    const { school, staff, block } = await setupImpactFixture([0, 1, 2, 3, 4]);

    await createSession({
      blockId: block.id, schoolId: school.id, staffProfileId: staff.id,
      date: nextSchemaDayDate(1), status: 'UPCOMING', // Tuesday — in new policy
    });

    const impact = await computePolicyImpact(school.id, { activeDays: [0, 1, 2, 3, 4] });

    expect(impact.sessionsOutsideDays).toBe(0);
    expect(impact.sessionsOutsideHours).toBe(0);
  });
});

// ─── computePolicyImpact — response shape ────────────────────────────────────

describe('computePolicyImpact — response fields', () => {
  it('returns policyEffectiveFrom as an ISO string for next Monday', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    const { date: nextMon } = getNextMondayDateInTz('UTC');

    const impact = await computePolicyImpact(school.id, { activeDays: [0, 1, 2, 3, 4] }, nextMon);

    expect(impact.policyEffectiveFrom).toBeTruthy();
    const parsed = new Date(impact.policyEffectiveFrom);
    expect(parsed.getUTCDay()).toBe(1); // Monday
  });

  it('returns firstWorkingDate = next Monday when Mon (0) is active', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    const { date: nextMon } = getNextMondayDateInTz('UTC');

    const impact = await computePolicyImpact(school.id, { activeDays: [0, 1, 2, 3, 4] }, nextMon);

    const fwd = new Date(`${impact.firstWorkingDate}T12:00:00Z`);
    const schemaDow = (fwd.getUTCDay() + 6) % 7;
    expect(schemaDow).toBe(0); // schema 0 = Monday
  });

  it('returns firstWorkingDate = next Tuesday when Monday excluded', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    const { date: nextMon } = getNextMondayDateInTz('UTC');

    const impact = await computePolicyImpact(school.id, { activeDays: [1, 2, 3, 4] }, nextMon); // no Monday

    const fwd = new Date(`${impact.firstWorkingDate}T12:00:00Z`);
    const schemaDow = (fwd.getUTCDay() + 6) % 7;
    expect(schemaDow).toBe(1); // schema 1 = Tuesday
  });

  it('includes affected block id when block days overlap removed days', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    await createFinanceConfig(school.id);
    const tUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(tUser.id, school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id,
      days: [0, 1, 2, 3, 4], // Mon-Fri
    });

    const { date: nextMon } = getNextMondayDateInTz('UTC');
    const impact = await computePolicyImpact(school.id, { activeDays: [1, 2, 3, 4] }, nextMon);

    expect(Array.isArray(impact.affectedBlockIds)).toBe(true);
    expect(impact.affectedBlockIds).toContain(block.id);
    expect(impact.blocksOutsideDays).toBeGreaterThanOrEqual(1);
  });

  it('returns empty affectedBlockIds when all blocks fit the proposed policy', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    await createFinanceConfig(school.id);
    const tUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(tUser.id, school.id);
    const group = await createGroup(school.id);
    await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id,
      days: [1, 2, 3], // Tue-Thu — fits Mon-Fri policy
    });

    const { date: nextMon } = getNextMondayDateInTz('UTC');
    const impact = await computePolicyImpact(school.id, { activeDays: [0, 1, 2, 3, 4] }, nextMon);

    expect(impact.affectedBlockIds).toHaveLength(0);
  });

  it('returns removedDays as the diff between old and new activeDays', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });

    const impact = await computePolicyImpact(school.id, { activeDays: [1, 2, 3, 4] }); // remove Mon

    expect(impact.removedDays).toEqual([0]); // Monday removed
  });

  it('includes an itemized affectedGroups entry with group name, level and reason', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    await createFinanceConfig(school.id);
    const tUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(tUser.id, school.id);
    const group = await createGroup(school.id);
    const block = await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id,
      days: [0, 1, 2, 3, 4], // Mon-Fri
    });

    const { date: nextMon } = getNextMondayDateInTz('UTC');
    const impact = await computePolicyImpact(school.id, { activeDays: [1, 2, 3, 4] }, nextMon); // remove Mon

    expect(impact.affectedGroups).toHaveLength(1);
    expect(impact.affectedGroups![0]).toMatchObject({
      blockId: block.id,
      studentGroupId: group.id,
      groupName: group.level,
      level: group.level,
      reason: 'NON_WORKING_DAY',
    });
  });

  it('excludes closed blocks (endDate in the past) from affectedGroups', async () => {
    const school = await createSchool({ timezone: 'UTC', activeDays: [0, 1, 2, 3, 4] });
    await createFinanceConfig(school.id);
    const tUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(tUser.id, school.id);
    const group = await createGroup(school.id);
    await createBlock({
      groupId: group.id, schoolId: school.id, staffProfileId: staff.id,
      days: [0, 1, 2, 3, 4], // Mon-Fri — would conflict if still active
      endDate: new Date('2020-01-01'), // closed history from a prior reschedule/split
    });

    const { date: nextMon } = getNextMondayDateInTz('UTC');
    const impact = await computePolicyImpact(school.id, { activeDays: [1, 2, 3, 4] }, nextMon);

    expect(impact.affectedGroups).toHaveLength(0);
    expect(impact.affectedBlockIds).toHaveLength(0);
  });
});
