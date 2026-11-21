import { BlockType, Role } from '@prisma/client';
import { cleanDb, prisma } from '../helpers/testDb';
import { ScheduleValidationError, validateScheduleBlock } from '../../services/scheduleValidation';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

async function setupPair() {
  const school = await prisma.school.create({
    data: {
      name: 'Pair Save School',
      city: 'Bishkek',
      email: `pair-save-${Date.now()}@test.local`,
      slug: `pair-save-${Date.now()}`,
      timezone: 'UTC',
      activeDays: [0, 1, 2, 3, 4, 5],
      workStart: '09:00',
      workEnd: '18:00',
      slotDuration: 60,
    },
  });
  const cabinet = await prisma.cabinet.create({
    data: { schoolId: school.id, name: '6', capacity: 12 },
  });
  const slot = await prisma.timeSlot.create({
    data: { schoolId: school.id, startTime: '12:00', endTime: '14:00', order: 1 },
  });
  const group = await prisma.studentGroup.create({
    data: {
      schoolId: school.id,
      level: 'Elementary',
      chapter: 1,
      maxStudents: 12,
      status: 'ACTIVE',
    },
  });
  const teacherUser = await prisma.user.create({
    data: {
      schoolId: school.id,
      role: Role.TEACHER,
      firstName: 'Teacher',
      lastName: 'One',
      email: `teacher-${Date.now()}@test.local`,
      password: 'hashed',
    },
  });
  const teacher = await prisma.staffProfile.create({
    data: { userId: teacherUser.id, salaryRate: 5000, workingDays: [0, 1, 2, 3, 4, 5] },
  });
  const grammar = await prisma.lessonBlock.create({
    data: {
      schoolId: school.id,
      cabinetId: cabinet.id,
      teacherId: teacher.id,
      studentGroupId: group.id,
      timeSlotId: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      days: [0, 2, 4],
      level: group.level,
      chapter: group.chapter,
      maxStudents: group.maxStudents,
      type: BlockType.GRAMMAR,
      startDate: new Date('2026-05-01T12:00:00.000Z'),
    },
  });
  const club = await prisma.lessonBlock.create({
    data: {
      schoolId: school.id,
      cabinetId: cabinet.id,
      teacherId: teacher.id,
      studentGroupId: group.id,
      timeSlotId: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      days: [1, 3, 5],
      level: group.level,
      chapter: group.chapter,
      maxStudents: group.maxStudents,
      type: BlockType.SPEAKING_CLUB,
      startDate: new Date('2026-05-01T12:00:00.000Z'),
    },
  });

  return { school, cabinet, slot, group, teacher, grammar, club };
}

describe('Grammar/Club pair validation', () => {
  it('allows swapping days when both current pair block ids are excluded', async () => {
    const { school, cabinet, slot, group, teacher, grammar, club } = await setupPair();
    const excludeBlockIds = [grammar.id, club.id];

    await expect(validateScheduleBlock(prisma, {
      schoolId: school.id,
      cabinetId: cabinet.id,
      teacherId: teacher.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      days: [1, 3],
      startDate: grammar.startDate,
      endDate: null,
      maxStudents: group.maxStudents,
      studentGroupId: group.id,
      blockId: grammar.id,
      excludeBlockIds,
      blockType: BlockType.GRAMMAR,
      isAdminOrOwner: true,
    })).resolves.toBe(true);

    await expect(validateScheduleBlock(prisma, {
      schoolId: school.id,
      cabinetId: cabinet.id,
      teacherId: teacher.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      days: [0, 2, 4],
      startDate: club.startDate,
      endDate: null,
      maxStudents: group.maxStudents,
      studentGroupId: group.id,
      blockId: club.id,
      excludeBlockIds,
      blockType: BlockType.SPEAKING_CLUB,
      isAdminOrOwner: true,
    })).resolves.toBe(true);
  });

  it('would reject the same swap without pair exclusion because the old sibling still exists', async () => {
    const { school, cabinet, slot, group, teacher, grammar } = await setupPair();

    await expect(validateScheduleBlock(prisma, {
      schoolId: school.id,
      cabinetId: cabinet.id,
      teacherId: teacher.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      days: [1, 3],
      startDate: grammar.startDate,
      endDate: null,
      maxStudents: group.maxStudents,
      studentGroupId: group.id,
      blockId: grammar.id,
      blockType: BlockType.GRAMMAR,
      isAdminOrOwner: true,
    })).rejects.toThrow(ScheduleValidationError);
  });
});
