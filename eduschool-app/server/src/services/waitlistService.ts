import prisma from '../lib/prisma';
import { notify } from '../lib/notify';
import { createLogger } from '../lib/logger';

const log = createLogger('waitlistService');

// Проверяет есть ли место в группе и авто-одобряет первого в очереди.
// Вызывается после каждого выхода студента из группы.
export async function tryPromoteWaitlist(groupId: number, schoolId: number): Promise<void> {
  const group = await prisma.studentGroup.findFirst({
    where: { id: groupId, schoolId, deletedAt: null },
    select: { id: true, maxStudents: true, level: true },
  });
  if (!group) return;

  const activeCount = await prisma.groupMembership.count({
    where: { studentGroupId: groupId, status: 'ACTIVE' },
  });

  if (activeCount >= group.maxStudents) return; // мест нет

  const now = new Date();

  // Старейшая не-просроченная PENDING заявка на эту группу
  const next = await prisma.enrollmentRequest.findFirst({
    where: {
      studentGroupId: groupId,
      schoolId,
      status: 'PENDING',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      studentProfileId: true,
      studentProfile: { select: { userId: true } },
    },
  });

  if (!next) return;

  // Получаем блоки группы для снапшота сессий
  const groupBlocks = await prisma.lessonBlock.findMany({
    where: { studentGroupId: groupId, deletedAt: null },
    select: { id: true },
  });
  const blockIds = groupBlocks.map(b => b.id);

  await prisma.$transaction(async (tx) => {
    // Одобряем заявку
    await tx.enrollmentRequest.update({
      where: { id: next.id },
      data: { status: 'APPROVED' },
    });

    // Создаём/восстанавливаем GroupMembership
    await tx.groupMembership.upsert({
      where: { studentProfileId_studentGroupId: { studentProfileId: next.studentProfileId, studentGroupId: groupId } },
      create: { schoolId, studentProfileId: next.studentProfileId, studentGroupId: groupId, joinedAt: now, status: 'ACTIVE' },
      update: { status: 'ACTIVE', leftAt: null, joinedAt: now },
    });

    // Снапшот в предстоящие сессии
    if (blockIds.length > 0) {
      const upcoming = await tx.lessonSession.findMany({
        where: { lessonBlockId: { in: blockIds }, status: 'UPCOMING', date: { gte: now }, deletedAt: null },
        select: { id: true },
      });
      if (upcoming.length > 0) {
        await tx.sessionStudent.createMany({
          data: upcoming.map(s => ({ schoolId, lessonSessionId: s.id, studentProfileId: next.studentProfileId })),
          skipDuplicates: true,
        });
      }
    }
  });

  // Уведомляем студента
  await notify({
    userId: next.studentProfile.userId,
    type: 'WAITLIST_PROMOTED',
    title: 'Вас зачислили в группу',
    body: `Место освободилось — вы автоматически зачислены в группу «${group.level}».`,
    data: { groupId },
  });

  log.info({ studentProfileId: next.studentProfileId, groupId }, 'student auto-promoted from waitlist');
}

// Удаляет просроченные PENDING заявки — запускать раз в сутки
export async function cleanupExpiredEnrollmentRequests(): Promise<void> {
  const { count } = await prisma.enrollmentRequest.deleteMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
  });
  if (count > 0) log.info({ count }, 'expired waitlist requests removed');
}
