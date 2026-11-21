import prisma from '../lib/prisma';
import { notifySchoolAdmins } from '../lib/notify';
import { createLogger } from '../lib/logger';

const log = createLogger('churnService');

const CHURN_THRESHOLD = 3;          // пропусков подряд → at risk
const ALERT_COOLDOWN_DAYS = 7;      // не спамить чаще раза в неделю

export async function checkChurnRisk(): Promise<void> {
  log.info('churn risk check started');

  const schools = await prisma.school.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true },
  });

  let alerted = 0;
  let cleared = 0;

  for (const school of schools) {
    // Все активные студенты школы
    const memberships = await prisma.groupMembership.findMany({
      where: { schoolId: school.id, status: 'ACTIVE', studentGroup: { deletedAt: null } },
      select: { studentProfileId: true },
      distinct: ['studentProfileId'],
    });

    for (const { studentProfileId } of memberships) {
      const profile = await prisma.studentProfile.findUnique({
        where: { id: studentProfileId },
        select: { id: true, atRiskSince: true, isFrozen: true, userId: true },
      });
      if (!profile || profile.isFrozen) continue;

      // Последние N посещаемостей студента
      const recent = await prisma.attendance.findMany({
        where: { studentProfileId, schoolId: school.id },
        orderBy: { createdAt: 'desc' },
        take: CHURN_THRESHOLD,
        select: { status: true },
      });

      if (recent.length < CHURN_THRESHOLD) continue;

      const allAbsent = recent.every(a => a.status === 'ABSENT');

      if (allAbsent) {
        const now = new Date();
        const cooloffBoundary = new Date(now.getTime() - ALERT_COOLDOWN_DAYS * 86_400_000);
        const alreadyAlerted = profile.atRiskSince && profile.atRiskSince > cooloffBoundary;

        if (!alreadyAlerted) {
          const user = await prisma.user.findUnique({
            where: { id: profile.userId },
            select: { firstName: true, lastName: true },
          });
          const name = user ? `${user.firstName} ${user.lastName}` : `Студент #${studentProfileId}`;

          await prisma.studentProfile.update({
            where: { id: studentProfileId },
            data: { atRiskSince: now },
          });

          await notifySchoolAdmins(school.id, {
            type: 'CHURN_RISK',
            title: 'Студент под риском ухода',
            body: `${name} пропустил(а) ${CHURN_THRESHOLD} урока подряд. Рекомендуем связаться.`,
            data: { studentProfileId },
          });

          alerted++;
        }
      } else if (profile.atRiskSince) {
        // Студент вернулся — сбрасываем флаг
        await prisma.studentProfile.update({
          where: { id: studentProfileId },
          data: { atRiskSince: null },
        });
        cleared++;
      }
    }
  }

  log.info({ alerted, cleared }, 'churn risk check finished');
}
