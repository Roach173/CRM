/**
 * Integration: assertTeacherOwnsSession (scheduleRouteUtils.ts)
 *
 * Regression test for the 2026-08-09 audit finding: TEACHER-role actors could
 * mark attendance / change status on ANY session in their school, not just
 * sessions assigned to them — contradicts CLAUDE.md's "TEACHER: assigned
 * sessions only" role scope.
 */

import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStaffProfile,
  createGroup,
  createBlock,
  createSession,
} from '../helpers/testDb';

import { assertTeacherOwnsSession, TeacherOwnershipError } from '../../routes/schedule/scheduleRouteUtils';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setup() {
  const school = await createSchool();
  const group = await createGroup(school.id);

  const ownTeacherUser = await createUser(school.id, 'TEACHER');
  const ownStaff = await createStaffProfile(ownTeacherUser.id, school.id);

  const otherTeacherUser = await createUser(school.id, 'TEACHER');
  const otherStaff = await createStaffProfile(otherTeacherUser.id, school.id);

  const ownerUser = await createUser(school.id, 'OWNER');

  const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: ownStaff.id });
  const session = await createSession({
    blockId: block.id,
    schoolId: school.id,
    staffProfileId: ownStaff.id,
    date: new Date('2026-01-05T12:00:00.000Z'),
  });

  return { school, ownTeacherUser, ownStaff, otherTeacherUser, otherStaff, ownerUser, session };
}

describe('assertTeacherOwnsSession', () => {
  it('resolves for the teacher actually assigned to the session', async () => {
    const { ownTeacherUser, session } = await setup();
    const req = { user: { userId: ownTeacherUser.id, role: 'TEACHER' as const } };
    await expect(assertTeacherOwnsSession(req, session.id)).resolves.toBeUndefined();
  });

  it('throws TeacherOwnershipError for a different teacher in the same school', async () => {
    const { otherTeacherUser, session } = await setup();
    const req = { user: { userId: otherTeacherUser.id, role: 'TEACHER' as const } };
    await expect(assertTeacherOwnsSession(req, session.id)).rejects.toThrow(TeacherOwnershipError);
  });

  it('rejection carries httpStatus 403 (so sendLifecycleError surfaces it, not a generic 500)', async () => {
    const { otherTeacherUser, session } = await setup();
    const req = { user: { userId: otherTeacherUser.id, role: 'TEACHER' as const } };
    await expect(assertTeacherOwnsSession(req, session.id)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('is a no-op for OWNER — may act on any session in the school', async () => {
    const { ownerUser, session } = await setup();
    const req = { user: { userId: ownerUser.id, role: 'OWNER' as const } };
    await expect(assertTeacherOwnsSession(req, session.id)).resolves.toBeUndefined();
  });

  it('resolves for the substitute teacher when isManualTeacher overrides the block default', async () => {
    const { ownTeacherUser, otherTeacherUser, otherStaff, session } = await setup();
    // Simulate a substitute assignment: teacherId + isManualTeacher=true wins over teacherIdSnap.
    await prisma.lessonSession.update({
      where: { id: session.id },
      data: { teacherId: otherStaff.id, isManualTeacher: true },
    });
    const substituteReq = { user: { userId: otherTeacherUser.id, role: 'TEACHER' as const } };
    await expect(assertTeacherOwnsSession(substituteReq, session.id)).resolves.toBeUndefined();

    // The original assigned teacher is now correctly rejected — substitute takes over.
    const originalReq = { user: { userId: ownTeacherUser.id, role: 'TEACHER' as const } };
    await expect(assertTeacherOwnsSession(originalReq, session.id)).rejects.toThrow(TeacherOwnershipError);
  });

  it('throws TeacherOwnershipError (404) for a non-existent session', async () => {
    const { ownTeacherUser } = await setup();
    const req = { user: { userId: ownTeacherUser.id, role: 'TEACHER' as const } };
    await expect(assertTeacherOwnsSession(req, 999999)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
