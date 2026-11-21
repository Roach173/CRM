/**
 * Integration: Phase 10 — Permissions / Security / Enterprise Readiness.
 *
 * Covers:
 *  - Permission model: new permissions ADMIN-denied / OWNER-allowed
 *  - Audit log: ScheduleActionLog pagination and tenant isolation
 */
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
} from '../helpers/testDb';
import { can } from '../../lib/permissions';
import { Role } from '@prisma/client';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// ─── Permission model — new permissions ───────────────────────────────────────

describe('Permission model — salary:pay', () => {
  it('ADMIN cannot salary:pay', () => {
    expect(can(Role.ADMIN, 'salary:pay')).toBe(false);
  });
  it('OWNER can salary:pay', () => {
    expect(can(Role.OWNER, 'salary:pay')).toBe(true);
  });
  it('SUPERADMIN can salary:pay', () => {
    expect(can(Role.SUPERADMIN, 'salary:pay')).toBe(true);
  });
});

describe('Permission model — salary:read and salary:write', () => {
  it('ADMIN can salary:read', () => {
    expect(can(Role.ADMIN, 'salary:read')).toBe(true);
  });
  it('ADMIN can salary:write (adjustments, manual entries)', () => {
    expect(can(Role.ADMIN, 'salary:write')).toBe(true);
  });
  it('TEACHER cannot salary:read', () => {
    expect(can(Role.TEACHER, 'salary:read')).toBe(false);
  });
});

describe('Permission model — groups:archive', () => {
  it('ADMIN cannot groups:archive', () => {
    expect(can(Role.ADMIN, 'groups:archive')).toBe(false);
  });
  it('OWNER can groups:archive', () => {
    expect(can(Role.OWNER, 'groups:archive')).toBe(true);
  });
});

describe('Permission model — data:import', () => {
  it('ADMIN cannot data:import', () => {
    expect(can(Role.ADMIN, 'data:import')).toBe(false);
  });
  it('OWNER can data:import', () => {
    expect(can(Role.OWNER, 'data:import')).toBe(true);
  });
});

describe('Permission model — finance:void and finance:refund', () => {
  it('ADMIN cannot finance:void', () => {
    expect(can(Role.ADMIN, 'finance:void')).toBe(false);
  });
  it('ADMIN cannot finance:refund', () => {
    expect(can(Role.ADMIN, 'finance:refund')).toBe(false);
  });
  it('OWNER can finance:void', () => {
    expect(can(Role.OWNER, 'finance:void')).toBe(true);
  });
  it('OWNER can finance:refund', () => {
    expect(can(Role.OWNER, 'finance:refund')).toBe(true);
  });
});

describe('Permission model — existing permissions unchanged', () => {
  it('ADMIN can schedule:write (pause/resume groups still works)', () => {
    expect(can(Role.ADMIN, 'schedule:write')).toBe(true);
  });
  it('ADMIN cannot schedule:delete', () => {
    expect(can(Role.ADMIN, 'schedule:delete')).toBe(false);
  });
  it('ADMIN can finance:read', () => {
    expect(can(Role.ADMIN, 'finance:read')).toBe(true);
  });
  it('ADMIN cannot finance:write', () => {
    expect(can(Role.ADMIN, 'finance:write')).toBe(false);
  });
});

// ─── Permission model — settings:write matrix ────────────────────────────────

describe('Permission model — settings:write', () => {
  // ADMIN: can save operational CRM settings (pause, group-size, cabinets)
  it('ADMIN can settings:write', () => {
    expect(can(Role.ADMIN, 'settings:write')).toBe(true);
  });
  it('ADMIN can settings:read', () => {
    expect(can(Role.ADMIN, 'settings:read')).toBe(true);
  });

  // OWNER / SUPERADMIN: full access
  it('OWNER can settings:write', () => {
    expect(can(Role.OWNER, 'settings:write')).toBe(true);
  });
  it('SUPERADMIN can settings:write', () => {
    expect(can(Role.SUPERADMIN, 'settings:write')).toBe(true);
  });

  // TEACHER / STUDENT: no access
  it('TEACHER cannot settings:write', () => {
    expect(can(Role.TEACHER, 'settings:write')).toBe(false);
  });
  it('STUDENT cannot settings:write', () => {
    expect(can(Role.STUDENT, 'settings:write')).toBe(false);
  });

  // ADMIN still cannot finance:write (finance config is OWNER-only at route level)
  it('ADMIN cannot finance:write', () => {
    expect(can(Role.ADMIN, 'finance:write')).toBe(false);
  });
  // ADMIN cannot finance:void / finance:refund
  it('ADMIN cannot finance:void', () => {
    expect(can(Role.ADMIN, 'finance:void')).toBe(false);
  });
});

// ─── Audit log — pagination ───────────────────────────────────────────────────

describe('Audit log pagination', () => {
  it('paginates ScheduleActionLog and returns correct count', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const user = await createUser(school.id, 'OWNER');

    for (let i = 1; i <= 15; i++) {
      await prisma.scheduleActionLog.create({
        data: {
          schoolId: school.id,
          userId: user.id,
          action: `TEST_ACTION_${i}`,
          entityType: 'session',
        },
      });
    }

    const page  = 1;
    const limit = 10;
    const [total, entries] = await Promise.all([
      prisma.scheduleActionLog.count({ where: { schoolId: school.id } }),
      prisma.scheduleActionLog.findMany({
        where: { schoolId: school.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    expect(total).toBe(15);
    expect(entries).toHaveLength(10);
    expect(Math.ceil(total / limit)).toBe(2);
  });

  it('returns remaining items on second page', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const user = await createUser(school.id, 'OWNER');

    for (let i = 1; i <= 15; i++) {
      await prisma.scheduleActionLog.create({
        data: { schoolId: school.id, userId: user.id, action: `TEST_${i}`, entityType: 'session' },
      });
    }

    const page  = 2;
    const limit = 10;
    const entries = await prisma.scheduleActionLog.findMany({
      where: { schoolId: school.id },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    expect(entries).toHaveLength(5);
  });
});

// ─── Audit log — entityType filter ────────────────────────────────────────────

describe('Audit log entityType filter', () => {
  it('filters by entityType correctly', async () => {
    const school = await createSchool({ timezone: 'UTC' });
    const user = await createUser(school.id, 'OWNER');

    await prisma.scheduleActionLog.create({
      data: { schoolId: school.id, userId: user.id, action: 'SALARY_PAY', entityType: 'payment' },
    });
    await prisma.scheduleActionLog.create({
      data: { schoolId: school.id, userId: user.id, action: 'SESSION_CANCEL', entityType: 'session' },
    });
    await prisma.scheduleActionLog.create({
      data: { schoolId: school.id, userId: user.id, action: 'BULK_IMPORT_STUDENTS', entityType: 'import' },
    });

    const paymentLogs = await prisma.scheduleActionLog.findMany({
      where: { schoolId: school.id, entityType: 'payment' },
    });
    const importLogs = await prisma.scheduleActionLog.findMany({
      where: { schoolId: school.id, entityType: 'import' },
    });

    expect(paymentLogs).toHaveLength(1);
    expect(paymentLogs[0].action).toBe('SALARY_PAY');
    expect(importLogs).toHaveLength(1);
    expect(importLogs[0].action).toBe('BULK_IMPORT_STUDENTS');
  });
});

// ─── Pause settings — payload validation (DB-level) ──────────────────────────

describe('Pause settings — persistence and retrieval', () => {
  it('saves numeric pauseRules and reads them back', async () => {
    const school = await createSchool({ timezone: 'UTC' });

    await prisma.school.update({
      where: { id: school.id },
      data: {
        settings: {
          pauseRules: { allowed: true, maxDays: 14, minNotice: 2, timesPerYear: 3 },
        },
      },
    });

    const updated = await prisma.school.findFirst({
      where: { id: school.id },
      select: { settings: true },
    });
    const rules = (updated?.settings as any)?.pauseRules;
    expect(rules.allowed).toBe(true);
    expect(rules.maxDays).toBe(14);
    expect(rules.minNotice).toBe(2);
    expect(rules.timesPerYear).toBe(3);
  });

  it('null maxDays and timesPerYear (unlimited) round-trips correctly', async () => {
    const school = await createSchool({ timezone: 'UTC' });

    await prisma.school.update({
      where: { id: school.id },
      data: {
        settings: {
          pauseRules: { allowed: true, maxDays: null, minNotice: 0, timesPerYear: null },
        },
      },
    });

    const updated = await prisma.school.findFirst({
      where: { id: school.id },
      select: { settings: true },
    });
    const rules = (updated?.settings as any)?.pauseRules;
    expect(rules.maxDays).toBeNull();
    expect(rules.timesPerYear).toBeNull();
  });
});

// ─── Pause settings — permission matrix ──────────────────────────────────────

describe('Permission model — pause settings access', () => {
  it('ADMIN can settings:write (pause settings allowed)', () => {
    expect(can(Role.ADMIN, 'settings:write')).toBe(true);
  });
  it('OWNER can settings:write', () => {
    expect(can(Role.OWNER, 'settings:write')).toBe(true);
  });
  it('SUPERADMIN can settings:write', () => {
    expect(can(Role.SUPERADMIN, 'settings:write')).toBe(true);
  });
  it('TEACHER cannot settings:write', () => {
    expect(can(Role.TEACHER, 'settings:write')).toBe(false);
  });
  it('STUDENT cannot settings:write', () => {
    expect(can(Role.STUDENT, 'settings:write')).toBe(false);
  });
});

// ─── Audit log — tenant isolation ────────────────────────────────────────────

describe('Audit log tenant isolation', () => {
  it('schoolA logs do not appear in schoolB queries', async () => {
    const schoolA = await createSchool({ timezone: 'UTC' });
    const schoolB = await createSchool({ timezone: 'UTC' });

    const userA = await createUser(schoolA.id, 'OWNER');

    await prisma.scheduleActionLog.create({
      data: { schoolId: schoolA.id, userId: userA.id, action: 'SALARY_PAY', entityType: 'payment' },
    });

    const schoolBLogs = await prisma.scheduleActionLog.findMany({
      where: { schoolId: schoolB.id },
    });

    expect(schoolBLogs).toHaveLength(0);
  });

  it('action filter combined with schoolId stays isolated', async () => {
    const schoolA = await createSchool({ timezone: 'UTC' });
    const schoolB = await createSchool({ timezone: 'UTC' });
    const userA = await createUser(schoolA.id, 'OWNER');
    const userB = await createUser(schoolB.id, 'OWNER');

    await prisma.scheduleActionLog.create({
      data: { schoolId: schoolA.id, userId: userA.id, action: 'SALARY_PAY', entityType: 'payment' },
    });
    await prisma.scheduleActionLog.create({
      data: { schoolId: schoolB.id, userId: userB.id, action: 'SALARY_PAY', entityType: 'payment' },
    });

    const schoolALogs = await prisma.scheduleActionLog.findMany({
      where: { schoolId: schoolA.id, action: 'SALARY_PAY' },
    });

    // schoolA query returns only 1 log, even though schoolB also has SALARY_PAY
    expect(schoolALogs).toHaveLength(1);
    expect(schoolALogs[0].schoolId).toBe(schoolA.id);
  });
});
