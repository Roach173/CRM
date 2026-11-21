import prisma from '../lib/prisma';
import { createLogger } from '../lib/logger';

const log = createLogger('archivalService');
const ARCHIVE_CUTOFF_MONTHS = 24;
const BATCH_SIZE = 500;

export async function archiveOldSessions(): Promise<void> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - ARCHIVE_CUTOFF_MONTHS);

  let archived = 0;
  let hasMore = true;

  while (hasMore) {
    const candidates = await prisma.$queryRaw<{ id: number }[]>`
      SELECT ls."id"
      FROM "LessonSession" ls
      WHERE ls."status" = 'COMPLETED'
        AND ls."date" < ${cutoff}
        AND ls."deletedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "LessonSessionArchive" a WHERE a."id" = ls."id"
        )
      ORDER BY ls."id" ASC
      LIMIT ${BATCH_SIZE}
    `;

    const sessions = await prisma.lessonSession.findMany({
      where: {
        id: { in: candidates.map(s => s.id) },
      },
      include: { attendances: true },
    });

    if (sessions.length === 0) { hasMore = false; break; }

    await prisma.$transaction(async (tx) => {
      // Copy-only archive: hot attendance/session rows remain in place.
      // Phase 1 FK guards intentionally make destructive session archival unsafe.
      const allAttendances = sessions.flatMap(s => s.attendances);
      if (allAttendances.length > 0) {
        await tx.attendanceArchive.createMany({
          data: allAttendances.map(a => ({
            id: a.id,
            schoolId: a.schoolId,
            lessonSessionId: a.lessonSessionId,
            studentProfileId: a.studentProfileId,
            status: a.status,
            creditDeducted: a.creditDeducted,
            createdAt: a.createdAt,
          })),
          skipDuplicates: true,
        });
      }

      await tx.lessonSessionArchive.createMany({
        data: sessions.map(s => ({
          id: s.id,
          schoolId: s.schoolId,
          lessonBlockId: s.lessonBlockId,
          date: s.date,
          teacherId: s.teacherId,
          teacherIdSnap: s.teacherIdSnap,
          cabinetIdSnap: s.cabinetIdSnap,
          startTimeSnap: s.startTimeSnap,
          endTimeSnap: s.endTimeSnap,
          status: s.status,
          isManualDate: s.isManualDate,
          dateOverrideFrom: s.dateOverrideFrom,
          isMakeup: s.isMakeup,
          makeupForSessionId: s.makeupForSessionId,
          createdAt: s.createdAt,
        })),
        skipDuplicates: true,
      });
    });

    archived += sessions.length;
    if (sessions.length < BATCH_SIZE) hasMore = false;
  }

  if (archived > 0) log.info({ archived }, 'snapshotted old sessions');
}
