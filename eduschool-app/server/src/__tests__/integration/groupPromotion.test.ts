import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import jwt from 'jsonwebtoken';
import {
  cleanDb,
  createBlock,
  createGroup,
  createMembership,
  createSchool,
  createSession,
  createStaffProfile,
  createStudentProfile,
  createUser,
  prisma,
} from '../helpers/testDb';
import groupsRouter from '../../routes/groups';
import { GroupPromotionService } from '../../services/groupPromotionService';

let server: Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/groups', groupsRouter);
  server = app.listen(0, done);
});

beforeEach(cleanDb);

afterAll((done) => {
  server.close(() => {
    prisma.$disconnect().finally(done);
  });
});

function baseUrl() {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function tokenFor(user: { id: number; role: string }, schoolId: number) {
  return jwt.sign(
    { userId: user.id, schoolId, role: user.role },
    process.env.JWT_SECRET || 'your-secret-key-here',
  );
}

async function setupPromotion() {
  const school = await createSchool();
  const owner = await createUser(school.id, 'OWNER');
  const group = await createGroup(school.id);
  const teacherUser = await createUser(school.id, 'TEACHER');
  const staff = await createStaffProfile(teacherUser.id, school.id);
  const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });

  const studentUser1 = await createUser(school.id, 'STUDENT');
  const student1 = await createStudentProfile(studentUser1.id, school.id);
  await createMembership(group.id, student1.id, school.id);

  const studentUser2 = await createUser(school.id, 'STUDENT');
  const student2 = await createStudentProfile(studentUser2.id, school.id);
  await createMembership(group.id, student2.id, school.id);

  return { school, owner, group, staff, block, student1, student2 };
}

// ─── Basic creation ───────────────────────────────────────────────────────────

describe('Phase 5: promote creates new group', () => {
  it('creates a new StudentGroup with target level/chapter', async () => {
    const { school, owner, group } = await setupPromotion();

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      targetChapter: 1,
      completeSourceGroup: false,
    });

    expect(result.newGroup.id).not.toBe(group.id);
    expect(result.newGroup.level).toBe('A2');
    expect(result.newGroup.chapter).toBe(1);

    const newGroupDb = await prisma.studentGroup.findUnique({ where: { id: result.newGroup.id } });
    expect(newGroupDb).not.toBeNull();
    expect(newGroupDb!.level).toBe('A2');
    expect(newGroupDb!.status).toBe('ACTIVE');
    expect(newGroupDb!.deletedAt).toBeNull();
  });

  it('source group level/chapter does not change after promote', async () => {
    const { school, owner, group } = await setupPromotion();

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    const sourceDb = await prisma.studentGroup.findUnique({ where: { id: group.id } });
    expect(sourceDb!.level).toBe('A1');
    expect(sourceDb!.chapter).toBe(1);
  });

  it('new group inherits maxStudents and pricePerMonth from source', async () => {
    const { school, owner, group } = await setupPromotion();
    await prisma.studentGroup.update({
      where: { id: group.id },
      data: { maxStudents: 12, pricePerMonth: 4500 },
    });

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'B1',
      completeSourceGroup: false,
    });

    const newGroupDb = await prisma.studentGroup.findUnique({ where: { id: result.newGroup.id } });
    expect(newGroupDb!.maxStudents).toBe(12);
    expect(Number(newGroupDb!.pricePerMonth)).toBe(4500);
  });
});

// ─── Students / Memberships ───────────────────────────────────────────────────

describe('Phase 5: student copy rules', () => {
  it('active students are copied to the new group', async () => {
    const { school, owner, group, student1, student2 } = await setupPromotion();

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    expect(result.copiedStudentsCount).toBe(2);

    const newMemberships = await prisma.groupMembership.findMany({
      where: { studentGroupId: result.newGroup.id, status: 'ACTIVE' },
    });
    const copiedIds = newMemberships.map(m => m.studentProfileId).sort();
    expect(copiedIds).toEqual([student1.id, student2.id].sort());

  });

  it('withdrawn/paused students are not copied', async () => {
    const { school, owner, group } = await setupPromotion();

    // Add a withdrawn student
    const withdrawnUser = await createUser(school.id, 'STUDENT');
    const withdrawnStudent = await createStudentProfile(withdrawnUser.id, school.id);
    await prisma.groupMembership.create({
      data: {
        schoolId: school.id,
        studentGroupId: group.id,
        studentProfileId: withdrawnStudent.id,
        status: 'WITHDRAWN',
      },
    });

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    // Only 2 active students copied, not the withdrawn one
    expect(result.copiedStudentsCount).toBe(2);
    const newMembership = await prisma.groupMembership.findFirst({
      where: { studentGroupId: result.newGroup.id, studentProfileId: withdrawnStudent.id },
    });
    expect(newMembership).toBeNull();
  });

  it('old memberships in source group are preserved', async () => {
    const { school, owner, group, student1, student2 } = await setupPromotion();

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    const sourceMemberships = await prisma.groupMembership.findMany({
      where: { studentGroupId: group.id, status: 'ACTIVE' },
    });
    expect(sourceMemberships).toHaveLength(2);
    expect(sourceMemberships.map(m => m.studentProfileId).sort()).toEqual(
      [student1.id, student2.id].sort(),
    );
  });
});

// ─── Attendance history ───────────────────────────────────────────────────────

describe('Phase 5: attendance history preservation', () => {
  it('old attendance records remain linked to the original session/group', async () => {
    const { school, owner, group, block, student1 } = await setupPromotion();

    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: (await prisma.lessonBlock.findUniqueOrThrow({ where: { id: block.id } })).teacherId!,
      date: new Date('2026-01-15T12:00:00.000Z'),
      status: 'COMPLETED',
    });
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: session.id,
        studentProfileId: student1.id,
        status: 'PRESENT',
        creditDeducted: true,
      },
    });

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    const attendance = await prisma.attendance.findFirst({
      where: { lessonSessionId: session.id, studentProfileId: student1.id },
    });
    expect(attendance).not.toBeNull();
    expect(attendance!.creditDeducted).toBe(true);

    // Session still links to original block (which is in source group)
    const sessionDb = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(sessionDb!.lessonBlockId).toBe(block.id);
  });
});

// ─── LessonBlock copy ─────────────────────────────────────────────────────────

describe('Phase 5: LessonBlock copy', () => {
  it('active LessonBlocks are copied to new group with UPCOMING status', async () => {
    const { school, owner, group, block, staff } = await setupPromotion();

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    expect(result.copiedBlocksCount).toBe(1);

    const newBlocks = await prisma.lessonBlock.findMany({
      where: { studentGroupId: result.newGroup.id },
    });
    expect(newBlocks).toHaveLength(1);
    expect(newBlocks[0].status).toBe('UPCOMING');
    expect(newBlocks[0].level).toBe('A2');
    expect(newBlocks[0].teacherId).toBe(staff.id);
    expect(newBlocks[0].days).toEqual(block.days);
    expect(newBlocks[0].startTime).toBe(block.startTime);
    expect(newBlocks[0].endTime).toBe(block.endTime);
    expect(newBlocks[0].deletedAt).toBeNull();
    expect(newBlocks[0].endDate).toBeNull();
  });

  it('source LessonBlock is not modified (non-complete mode)', async () => {
    const { school, owner, group, block } = await setupPromotion();

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    const sourceBlock = await prisma.lessonBlock.findUnique({ where: { id: block.id } });
    expect(sourceBlock!.status).toBe('UPCOMING');
    expect(sourceBlock!.endDate).toBeNull();
    expect(sourceBlock!.studentGroupId).toBe(group.id);
  });

  it('old LessonSessions are not moved or changed', async () => {
    const { school, owner, group, block, staff } = await setupPromotion();
    const session = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: new Date('2026-01-10T12:00:00.000Z'),
      status: 'COMPLETED',
    });

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    const sessionDb = await prisma.lessonSession.findUnique({ where: { id: session.id } });
    expect(sessionDb!.lessonBlockId).toBe(block.id);
    expect(sessionDb!.status).toBe('COMPLETED');
  });

  it('new blocks have no sessions (ready for syncSessionsForBlock)', async () => {
    const { school, owner, group } = await setupPromotion();

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    const newBlocks = await prisma.lessonBlock.findMany({
      where: { studentGroupId: result.newGroup.id },
    });
    for (const b of newBlocks) {
      const sessions = await prisma.lessonSession.findMany({ where: { lessonBlockId: b.id } });
      expect(sessions).toHaveLength(0);
    }
  });
});

// ─── GroupProgression link ────────────────────────────────────────────────────

describe('Phase 5: GroupProgression link', () => {
  it('creates a GroupProgression record linking source to new group', async () => {
    const { school, owner, group } = await setupPromotion();

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      targetChapter: 2,
      reason: 'end of A1 term',
      completeSourceGroup: false,
    });

    const progression = await prisma.groupProgression.findUnique({
      where: { id: result.progression.id },
    });
    expect(progression).not.toBeNull();
    expect(progression!.fromGroupId).toBe(group.id);
    expect(progression!.toGroupId).toBe(result.newGroup.id);
    expect(progression!.fromLevel).toBe('A1');
    expect(progression!.fromChapter).toBe(1);
    expect(progression!.toLevel).toBe('A2');
    expect(progression!.toChapter).toBe(2);
    expect(progression!.actorId).toBe(owner.id);
    expect(progression!.reason).toBe('end of A1 term');
    expect(progression!.schoolId).toBe(school.id);
  });

  it('creates GROUP_PROMOTED audit log', async () => {
    const { school, owner, group } = await setupPromotion();

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: false,
    });

    const audit = await prisma.scheduleActionLog.findFirst({
      where: { groupId: group.id, action: 'GROUP_PROMOTED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(owner.id);
    expect((audit!.after as any).targetGroupId).toBe(result.newGroup.id);
    expect((audit!.after as any).toLevel).toBe('A2');
    expect((audit!.after as any).copiedStudentsCount).toBe(2);
    expect((audit!.after as any).copiedBlocksCount).toBe(1);
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('Phase 5: promote error cases', () => {
  it('promote archived group is rejected with PROMOTE_SOURCE_ARCHIVED', async () => {
    const { school, owner, group } = await setupPromotion();
    await prisma.studentGroup.update({ where: { id: group.id }, data: { deletedAt: new Date() } });

    await expect(
      GroupPromotionService.promoteGroup({
        sourceGroupId: group.id,
        schoolId: school.id,
        actorId: owner.id,
        role: 'OWNER' as const,
        targetLevel: 'A2',
      }),
    ).rejects.toMatchObject({ code: 'PROMOTE_SOURCE_ARCHIVED' });
  });

  it('promote paused group is rejected with PROMOTE_SOURCE_PAUSED', async () => {
    const { school, owner, group } = await setupPromotion();
    await prisma.studentGroup.update({ where: { id: group.id }, data: { status: 'PAUSED' } });

    await expect(
      GroupPromotionService.promoteGroup({
        sourceGroupId: group.id,
        schoolId: school.id,
        actorId: owner.id,
        role: 'OWNER' as const,
        targetLevel: 'A2',
      }),
    ).rejects.toMatchObject({ code: 'PROMOTE_SOURCE_PAUSED' });
  });

  it('promote non-existent group returns PROMOTE_SOURCE_NOT_FOUND', async () => {
    const { school, owner } = await setupPromotion();

    await expect(
      GroupPromotionService.promoteGroup({
        sourceGroupId: 99999,
        schoolId: school.id,
        actorId: owner.id,
        role: 'OWNER' as const,
        targetLevel: 'A2',
      }),
    ).rejects.toMatchObject({ code: 'PROMOTE_SOURCE_NOT_FOUND' });
  });
});

// ─── completeSourceGroup semantics ───────────────────────────────────────────

describe('Phase 5: completeSourceGroup=true applies Phase 3 semantics', () => {
  it('source group status becomes COMPLETED', async () => {
    const { school, owner, group } = await setupPromotion();

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: true,
    });

    const sourceDb = await prisma.studentGroup.findUnique({ where: { id: group.id } });
    expect(sourceDb!.status).toBe('COMPLETED');
  });

  it('future UPCOMING sessions of source group become INVALIDATED, not CANCELLED', async () => {
    const { school, owner, group, block, staff } = await setupPromotion();
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    futureDate.setUTCHours(12, 0, 0, 0);
    const futureSession = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: futureDate,
      status: 'UPCOMING',
    });

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: true,
    });

    const sessionDb = await prisma.lessonSession.findUnique({ where: { id: futureSession.id } });
    expect(sessionDb!.status).toBe('INVALIDATED');
  });

  it('source blocks get status COMPLETED and endDate set', async () => {
    const { school, owner, group, block } = await setupPromotion();

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: true,
    });

    const blockDb = await prisma.lessonBlock.findUnique({ where: { id: block.id } });
    expect(blockDb!.status).toBe('COMPLETED');
    expect(blockDb!.endDate).not.toBeNull();
  });

  it('future sessions with attendance are NOT invalidated (protected history)', async () => {
    const { school, owner, group, block, staff, student1 } = await setupPromotion();
    const futureDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    futureDate.setUTCHours(12, 0, 0, 0);
    const protectedSession = await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: futureDate,
      status: 'UPCOMING',
    });
    // Session has attendance — must be protected
    await prisma.attendance.create({
      data: {
        schoolId: school.id,
        lessonSessionId: protectedSession.id,
        studentProfileId: student1.id,
        status: 'PRESENT',
        creditDeducted: false,
      },
    });

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: true,
    });

    const sessionDb = await prisma.lessonSession.findUnique({ where: { id: protectedSession.id } });
    expect(sessionDb!.status).toBe('UPCOMING');
  });

  it('promote with completeSourceGroup=true does not create any CANCELLED sessions', async () => {
    const { school, owner, group, block, staff } = await setupPromotion();
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    futureDate.setUTCHours(12, 0, 0, 0);
    await createSession({
      blockId: block.id,
      schoolId: school.id,
      staffProfileId: staff.id,
      date: futureDate,
      status: 'UPCOMING',
    });

    const result = await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: true,
    });

    // No CANCELLED sessions in either group
    const allBlockIds = [
      block.id,
      ...(await prisma.lessonBlock.findMany({ where: { studentGroupId: result.newGroup.id } })).map(b => b.id),
    ];
    const cancelled = await prisma.lessonSession.count({
      where: { lessonBlockId: { in: allBlockIds }, status: 'CANCELLED' },
    });
    expect(cancelled).toBe(0);
  });

  it('promote already COMPLETED source group is rejected', async () => {
    const { school, owner, group } = await setupPromotion();
    await prisma.studentGroup.update({ where: { id: group.id }, data: { status: 'COMPLETED' } });

    await expect(GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: true,
    })).rejects.toMatchObject({ code: 'PROMOTE_SOURCE_COMPLETED' });
  });

  it('GROUP_COMPLETED audit created when completeSourceGroup=true', async () => {
    const { school, owner, group } = await setupPromotion();

    await GroupPromotionService.promoteGroup({
      sourceGroupId: group.id,
      schoolId: school.id,
      actorId: owner.id,
      role: 'OWNER' as const,
      targetLevel: 'A2',
      completeSourceGroup: true,
    });

    const completedAudit = await prisma.scheduleActionLog.findFirst({
      where: { groupId: group.id, action: 'GROUP_COMPLETED' },
    });
    expect(completedAudit).not.toBeNull();
  });
});

// ─── Route integration ────────────────────────────────────────────────────────

describe('Phase 5: POST /groups/:id/promote route', () => {
  it('returns sourceGroup, newGroup, progression, copiedStudentsCount, copiedBlocksCount', async () => {
    const { school, owner, group } = await setupPromotion();
    const token = tokenFor(owner, school.id);

    const res = await fetch(`${baseUrl()}/groups/${group.id}/promote`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ newLevel: 'A2', completeSourceGroup: false }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.sourceGroup.id).toBe(group.id);
    expect(body.data.sourceGroup.level).toBe('A1');
    expect(body.data.newGroup.level).toBe('A2');
    expect(body.data.progression.fromGroupId).toBe(group.id);
    expect(typeof body.data.copiedStudentsCount).toBe('number');
    expect(typeof body.data.copiedBlocksCount).toBe('number');
  });

  it('returns 400 when newLevel is missing', async () => {
    const { school, owner, group } = await setupPromotion();
    const token = tokenFor(owner, school.id);

    const res = await fetch(`${baseUrl()}/groups/${group.id}/promote`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('returns 422 with code PROMOTE_SOURCE_PAUSED for paused group', async () => {
    const { school, owner, group } = await setupPromotion();
    await prisma.studentGroup.update({ where: { id: group.id }, data: { status: 'PAUSED' } });
    const token = tokenFor(owner, school.id);

    const res = await fetch(`${baseUrl()}/groups/${group.id}/promote`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ newLevel: 'A2' }),
    });
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe('PROMOTE_SOURCE_PAUSED');
  });

  it('returns 403 for non-admin user', async () => {
    const { school, group } = await setupPromotion();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const token = tokenFor(teacherUser, school.id);

    const res = await fetch(`${baseUrl()}/groups/${group.id}/promote`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ newLevel: 'A2' }),
    });

    expect(res.status).toBe(403);
  });
});
