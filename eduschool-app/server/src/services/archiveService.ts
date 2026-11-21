import prisma from '../lib/prisma';
import { createLogger } from '../lib/logger';

const log = createLogger('archiveService');

// Архивируем посещаемость старше ARCHIVE_DAYS дней.
// Сырые строки Attendance → агрегат в AttendanceMonthlySummary → перемещение в AttendanceArchive.
const ARCHIVE_DAYS = 90;

export async function archiveOldAttendance(): Promise<void> {
  log.info('attendance archival started');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ARCHIVE_DAYS);

  // Все школы с посещаемостью старше cutoff
  const schools = await prisma.school.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true },
  });

  let totalArchived = 0;

  for (const school of schools) {
    // Все старые записи посещаемости сгруппированные по студенту/году/месяцу
    const rows = await prisma.attendance.findMany({
      where: { schoolId: school.id, createdAt: { lt: cutoff } },
      select: {
        id: true,
        studentProfileId: true,
        status: true,
        creditDeducted: true,
        createdAt: true,
        lessonSessionId: true,
      },
    });

    if (rows.length === 0) continue;

    // Группируем по (studentProfileId, year, month)
    type Key = `${number}-${number}-${number}`;
    const groups = new Map<Key, typeof rows>();
    for (const row of rows) {
      const y = row.createdAt.getFullYear();
      const m = row.createdAt.getMonth() + 1;
      const key: Key = `${row.studentProfileId}-${y}-${m}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    for (const [key, entries] of groups) {
      const [spId, y, m] = key.split('-').map(Number);

      const totalSessions = entries.length;
      const attended = entries.filter(e => e.status === 'PRESENT').length;
      const absent   = entries.filter(e => e.status === 'ABSENT').length;
      const late     = entries.filter(e => e.status === 'LATE').length;
      const creditsDeducted = entries.filter(e => e.creditDeducted).length;

      await prisma.$transaction(async (tx) => {
        // Upsert в сводную таблицу (повторный запуск безопасен)
        await tx.attendanceMonthlySummary.upsert({
          where: {
            schoolId_studentProfileId_year_month: {
              schoolId: school.id,
              studentProfileId: spId,
              year: y,
              month: m,
            },
          },
          create: {
            schoolId: school.id,
            studentProfileId: spId,
            year: y,
            month: m,
            totalSessions,
            attended,
            absent,
            late,
            creditsDeducted,
          },
          update: {
            totalSessions,
            attended,
            absent,
            late,
            creditsDeducted,
            archivedAt: new Date(),
          },
        });

        // Перемещаем в архив
        await tx.attendanceArchive.createMany({
          data: entries.map(e => ({
            id: e.id,
            schoolId: school.id,
            lessonSessionId: e.lessonSessionId,
            studentProfileId: e.studentProfileId,
            status: e.status,
            creditDeducted: e.creditDeducted,
            createdAt: e.createdAt,
          })),
          skipDuplicates: true,
        });

        // This cron path is archival, not an ordinary API delete. The archive row keeps
        // attendance identity, session link, student, status, credit flag and createdAt.
        // Do not call this service from request handlers without a fuller ledger/archive review.
        await tx.attendance.deleteMany({
          where: { id: { in: entries.map(e => e.id) } },
        });
      });

      totalArchived += entries.length;
    }

    log.info({ schoolId: school.id, archived: rows.length }, 'school attendance archived');
  }

  log.info({ totalArchived }, 'attendance archival finished');
}
