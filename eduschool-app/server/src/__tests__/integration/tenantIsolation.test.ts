/**
 * Integration: Tenant Isolation — Phase 1 Hardening
 *
 * Strategy: create two isolated schools (A and B). All assertions are from
 * School A's perspective trying to read or mutate School B's data.
 * Every cross-tenant attempt must throw TenantNotFoundError.
 *
 * These tests run against a real PostgreSQL database (see .env.test).
 */

import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
  createStaffProfile,
  createGroup,
  createBlock,
} from '../helpers/testDb';

import {
  TenantNotFoundError,
  assertStudentBelongsToSchool,
  assertStudentsBelongToSchool,
  assertStaffBelongsToSchool,
  assertLessonBlockBelongsToSchool,
  assertTeacherPaymentBelongsToSchool,
  assertWebhookBelongsToSchool,
  assertIntegrationBelongsToSchool,
} from '../../lib/tenant';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

// ─── Shared fixture ───────────────────────────────────────────────────────────

async function setupTwoSchools() {
  const schoolA = await createSchool();
  const schoolB = await createSchool();

  // School B resources
  const teacherUserB = await createUser(schoolB.id, 'TEACHER');
  const staffB = await createStaffProfile(teacherUserB.id, schoolB.id);

  const studentUserB = await createUser(schoolB.id, 'STUDENT');
  const studentB = await createStudentProfile(studentUserB.id, schoolB.id, 10);

  const groupB = await createGroup(schoolB.id);
  const blockB = await createBlock({ groupId: groupB.id, schoolId: schoolB.id, staffProfileId: staffB.id });

  const paymentB = await prisma.teacherPayment.create({
    data: {
      schoolId: schoolB.id,
      staffProfileId: staffB.id,
      period: '2026-05',
      lessonsCount: 1,
      rateSnapshot: 500,
      amount: 500,
    },
  });

  const webhookB = await prisma.webhook.create({
    data: {
      schoolId: schoolB.id,
      url: 'https://webhook.test/b',
      events: ['attendance.marked'],
      secret: 'secret-b',
    },
  });

  const integrationB = await prisma.integrationConnection.create({
    data: {
      schoolId: schoolB.id,
      provider: 'placeholder',
      category: 'OTHER',
      status: 'active',
      enabled: true,
    },
  });

  return { schoolA, schoolB, staffB, studentB, groupB, blockB, paymentB, webhookB, integrationB };
}

// ─── assertStudentBelongsToSchool ─────────────────────────────────────────────

describe('assertStudentBelongsToSchool', () => {
  it('resolves when student belongs to the requesting school', async () => {
    const { schoolB, studentB } = await setupTwoSchools();
    await expect(assertStudentBelongsToSchool(studentB.id, schoolB.id)).resolves.toBeUndefined();
  });

  it('throws TenantNotFoundError when school A tries to access school B student', async () => {
    const { schoolA, studentB } = await setupTwoSchools();
    await expect(assertStudentBelongsToSchool(studentB.id, schoolA.id)).rejects.toThrow(TenantNotFoundError);
  });

  it('throws TenantNotFoundError for non-existent id', async () => {
    const { schoolA } = await setupTwoSchools();
    await expect(assertStudentBelongsToSchool(999999, schoolA.id)).rejects.toThrow(TenantNotFoundError);
  });
});

// ─── assertStudentsBelongToSchool ────────────────────────────────────────────

describe('assertStudentsBelongToSchool', () => {
  it('resolves for empty array', async () => {
    const { schoolA } = await setupTwoSchools();
    await expect(assertStudentsBelongToSchool([], schoolA.id)).resolves.toBeUndefined();
  });

  it('resolves when all students belong to the school', async () => {
    const { schoolB, studentB } = await setupTwoSchools();
    await expect(assertStudentsBelongToSchool([studentB.id], schoolB.id)).resolves.toBeUndefined();
  });

  it('throws when even one student is from a different school', async () => {
    const { schoolA, schoolB, studentB } = await setupTwoSchools();

    const userA = await createUser(schoolA.id, 'STUDENT');
    const studentA = await createStudentProfile(userA.id, schoolA.id, 5);

    // Mix: school A student + school B student → should fail for school A context
    await expect(
      assertStudentsBelongToSchool([studentA.id, studentB.id], schoolA.id)
    ).rejects.toThrow(TenantNotFoundError);
  });

  it('throws when all students are from a different school', async () => {
    const { schoolA, studentB } = await setupTwoSchools();
    await expect(assertStudentsBelongToSchool([studentB.id], schoolA.id)).rejects.toThrow(TenantNotFoundError);
  });
});

// ─── assertStaffBelongsToSchool ───────────────────────────────────────────────

describe('assertStaffBelongsToSchool', () => {
  it('resolves when staff belongs to the requesting school', async () => {
    const { schoolB, staffB } = await setupTwoSchools();
    await expect(assertStaffBelongsToSchool(staffB.id, schoolB.id)).resolves.toBeUndefined();
  });

  it('throws TenantNotFoundError for cross-tenant staff access', async () => {
    const { schoolA, staffB } = await setupTwoSchools();
    await expect(assertStaffBelongsToSchool(staffB.id, schoolA.id)).rejects.toThrow(TenantNotFoundError);
  });
});

// ─── assertLessonBlockBelongsToSchool ────────────────────────────────────────

describe('assertLessonBlockBelongsToSchool', () => {
  it('resolves when block belongs to the requesting school', async () => {
    const { schoolB, blockB } = await setupTwoSchools();
    await expect(assertLessonBlockBelongsToSchool(blockB.id, schoolB.id)).resolves.toBeUndefined();
  });

  it('throws TenantNotFoundError for cross-tenant block access', async () => {
    const { schoolA, blockB } = await setupTwoSchools();
    await expect(assertLessonBlockBelongsToSchool(blockB.id, schoolA.id)).rejects.toThrow(TenantNotFoundError);
  });
});

// ─── assertTeacherPaymentBelongsToSchool ─────────────────────────────────────

describe('assertTeacherPaymentBelongsToSchool', () => {
  it('resolves when payment belongs to the requesting school', async () => {
    const { schoolB, paymentB } = await setupTwoSchools();
    await expect(assertTeacherPaymentBelongsToSchool(paymentB.id, schoolB.id)).resolves.toBeUndefined();
  });

  it('throws TenantNotFoundError for cross-tenant payment access', async () => {
    const { schoolA, paymentB } = await setupTwoSchools();
    await expect(assertTeacherPaymentBelongsToSchool(paymentB.id, schoolA.id)).rejects.toThrow(TenantNotFoundError);
  });

  it('does not mutate school B payment when called from school A context', async () => {
    const { schoolA, schoolB, paymentB } = await setupTwoSchools();

    // Attempt cross-tenant access — must throw
    await expect(assertTeacherPaymentBelongsToSchool(paymentB.id, schoolA.id)).rejects.toThrow(TenantNotFoundError);

    // School B payment must still exist and be intact
    const still = await prisma.teacherPayment.findUnique({ where: { id: paymentB.id } });
    expect(still).not.toBeNull();
    expect(still!.schoolId).toBe(schoolB.id);
    expect(Number(still!.amount)).toBe(500);
  });
});

// ─── assertWebhookBelongsToSchool ────────────────────────────────────────────

describe('assertWebhookBelongsToSchool', () => {
  it('resolves when webhook belongs to the requesting school', async () => {
    const { schoolB, webhookB } = await setupTwoSchools();
    await expect(assertWebhookBelongsToSchool(webhookB.id, schoolB.id)).resolves.toBeUndefined();
  });

  it('throws TenantNotFoundError for cross-tenant webhook access', async () => {
    const { schoolA, webhookB } = await setupTwoSchools();
    await expect(assertWebhookBelongsToSchool(webhookB.id, schoolA.id)).rejects.toThrow(TenantNotFoundError);
  });
});

// ─── assertIntegrationBelongsToSchool ────────────────────────────────────────

describe('assertIntegrationBelongsToSchool', () => {
  it('resolves when integration belongs to the requesting school', async () => {
    const { schoolB, integrationB } = await setupTwoSchools();
    await expect(assertIntegrationBelongsToSchool(integrationB.id, schoolB.id)).resolves.toBeUndefined();
  });

  it('throws TenantNotFoundError for cross-tenant integration access', async () => {
    const { schoolA, integrationB } = await setupTwoSchools();
    await expect(assertIntegrationBelongsToSchool(integrationB.id, schoolA.id)).rejects.toThrow(TenantNotFoundError);
  });
});

// ─── Transaction context ──────────────────────────────────────────────────────

describe('helpers inside $transaction', () => {
  it('assertStaffBelongsToSchool works correctly inside a transaction', async () => {
    const { schoolA, schoolB, staffB } = await setupTwoSchools();

    // Cross-tenant access inside tx must throw and roll back
    await expect(
      prisma.$transaction(async (tx) => {
        await assertStaffBelongsToSchool(staffB.id, schoolA.id, tx);
        // This line must never execute
        await tx.staffProfile.update({ where: { id: staffB.id }, data: { salaryRate: 1 } });
      })
    ).rejects.toThrow(TenantNotFoundError);

    // Verify salary rate is unchanged — transaction rolled back
    const unchanged = await prisma.staffProfile.findUnique({ where: { id: staffB.id } });
    expect(Number(unchanged!.salaryRate)).toBe(5000); // default from createStaffProfile
  });

  it('assertStudentsBelongToSchool blocks cross-tenant connect inside a transaction', async () => {
    const { schoolA, schoolB, studentB, groupB } = await setupTwoSchools();

    // School A admin tries to connect school B's student to school B's group
    // This simulates the groups.ts POST /:id/students attack
    await expect(
      prisma.$transaction(async (tx) => {
        await assertStudentsBelongToSchool([studentB.id], schoolA.id, tx);
        await tx.studentGroup.update({
          where: { id: groupB.id },
          data: { students: { connect: { id: studentB.id } } },
        });
      })
    ).rejects.toThrow(TenantNotFoundError);

    // Verify student was NOT connected
    const group = await prisma.studentGroup.findUnique({
      where: { id: groupB.id },
      include: { students: { where: { id: studentB.id } } },
    });
    expect(group!.students).toHaveLength(0);
  });
});
