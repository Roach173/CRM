import prisma from '../lib/prisma';
import { ScheduleException } from '@prisma/client';

export async function getActiveExceptions(
  schoolId: number,
  from: Date,
  to: Date
): Promise<ScheduleException[]> {
  return prisma.scheduleException.findMany({
    where: {
      schoolId,
      AND: [
        { startDate: { lte: to } },
        { OR: [{ endDate: null }, { endDate: { gte: from } }] },
      ],
    },
  });
}

export function isDateExcepted(
  date: Date,
  exceptions: ScheduleException[],
  opts: { teacherId?: number; cabinetId?: number; groupId?: number }
): boolean {
  const dateUTCDay = (date.getUTCDay() + 6) % 7; // 0=Mon
  const dateStr = date.toISOString().split('T')[0];

  for (const ex of exceptions) {
    const start = ex.startDate.toISOString().split('T')[0];
    const end = ex.endDate ? ex.endDate.toISOString().split('T')[0] : null;

    if (dateStr < start) continue;
    if (end && dateStr > end) continue;

    if (ex.recurring) {
      if (!ex.days.includes(dateUTCDay)) continue;
    }

    // Scope matching
    if (ex.scope === 'SCHOOL') return true;
    if (ex.scope === 'TEACHER' && opts.teacherId && ex.teacherId === opts.teacherId) return true;
    if (ex.scope === 'CABINET' && opts.cabinetId && ex.cabinetId === opts.cabinetId) return true;
    if (ex.scope === 'GROUP' && opts.groupId && ex.groupId === opts.groupId) return true;
  }
  return false;
}
