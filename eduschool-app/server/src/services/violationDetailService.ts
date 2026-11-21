/**
 * VIOLATION DETAIL SERVICE
 * Resolves the raw entity ids returned by consistencyCheckService / reconciliationService
 * into human-readable details for the Finance Control page: who, which lesson, when,
 * and (where the entity traces to a LessonBlock) a deep-link target to open that exact
 * slot in the schedule grid — same contract as GroupDetail's "Открыть в расписании"
 * (?openBlockId=&openGroupId=&openStart=&openEnd=), consumed by Schedule.tsx.
 *
 * Every query is scoped to schoolId — the ids passed in already come from a
 * schoolId-scoped check, but this re-asserts tenant isolation per CLAUDE.md.
 */

import { PrismaClient } from '@prisma/client';

export interface ScheduleTarget {
  blockId: number;
  groupId: number | null;
  startTime: string;
  endTime: string;
}

export interface ViolationDetail {
  id: number;
  label: string;
  sublabel?: string;
  scheduleTarget?: ScheduleTarget;
}

export type ViolationEntityKind =
  | 'sessionStudent'
  | 'attendance'
  | 'lessonCreditLog'
  | 'teacherPaymentLesson'
  | 'lessonSession'
  | 'lessonBlock'
  | 'teacherPayment'
  | 'studentProfile'
  | 'invoice'
  | 'school';

type NameParts = { firstName: string; lastName: string };
function personName(u: NameParts): string {
  return `${u.firstName} ${u.lastName}`.trim();
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type BlockRef = {
  id: number; startTime: string; endTime: string; studentGroupId: number | null; deletedAt: Date | null;
  studentGroup: { deletedAt: Date | null } | null;
} | null | undefined;

// A deleted block, or one whose group was completed+archived, no longer exists in the
// schedule grid — Schedule.tsx's deep-link lookup only searches live groups, so linking
// there would just 404 as "group not found".
function blockTarget(b: BlockRef): ScheduleTarget | undefined {
  if (!b || b.deletedAt || b.studentGroup?.deletedAt) return undefined;
  return { blockId: b.id, groupId: b.studentGroupId, startTime: b.startTime, endTime: b.endTime };
}

// Explains why a row has no "Открыть в расписании" link instead of leaving it unexplained.
function blockNote(b: BlockRef): string {
  if (b?.deletedAt) return ' (блок удалён — уроки не были отменены)';
  if (b?.studentGroup?.deletedAt) return ' (группа завершена и архивирована — урок остался в статусе UPCOMING)';
  return '';
}

const blockSelect = {
  id: true, startTime: true, endTime: true, studentGroupId: true, level: true, deletedAt: true,
  studentGroup: { select: { deletedAt: true } },
} as const;

export async function resolveViolationDetails(
  kind: ViolationEntityKind,
  ids: number[],
  schoolId: number,
  prisma: PrismaClient,
): Promise<ViolationDetail[]> {
  if (ids.length === 0) return [];

  switch (kind) {
    case 'sessionStudent': {
      const rows = await prisma.sessionStudent.findMany({
        where: { id: { in: ids }, schoolId },
        select: {
          id: true,
          studentProfile: { select: { user: { select: { firstName: true, lastName: true } } } },
          lessonSession: { select: { date: true, lessonBlock: { select: blockSelect } } },
        },
      });
      return rows.map(r => ({
        id: r.id,
        label: personName(r.studentProfile.user),
        sublabel: `Группа ${r.lessonSession.lessonBlock.level} · урок ${fmtDate(r.lessonSession.date)}${blockNote(r.lessonSession.lessonBlock)}`,
        scheduleTarget: blockTarget(r.lessonSession.lessonBlock),
      }));
    }

    case 'attendance': {
      const rows = await prisma.attendance.findMany({
        where: { id: { in: ids }, schoolId },
        select: {
          id: true,
          studentProfile: { select: { user: { select: { firstName: true, lastName: true } } } },
          lessonSession: { select: { date: true, status: true, lessonBlock: { select: blockSelect } } },
        },
      });
      return rows.map(r => ({
        id: r.id,
        label: personName(r.studentProfile.user),
        sublabel: `Урок ${fmtDate(r.lessonSession.date)} (${r.lessonSession.status}) · группа ${r.lessonSession.lessonBlock.level}${blockNote(r.lessonSession.lessonBlock)}`,
        scheduleTarget: blockTarget(r.lessonSession.lessonBlock),
      }));
    }

    case 'lessonCreditLog': {
      const rows = await prisma.lessonCreditLog.findMany({
        where: { id: { in: ids }, schoolId },
        select: {
          id: true,
          amount: true,
          studentProfile: { select: { user: { select: { firstName: true, lastName: true } } } },
          session: { select: { date: true, lessonBlock: { select: blockSelect } } },
        },
      });
      return rows.map(r => ({
        id: r.id,
        label: personName(r.studentProfile.user),
        sublabel: r.session
          ? `${r.amount} кредит · урок ${fmtDate(r.session.date)} · группа ${r.session.lessonBlock.level}${blockNote(r.session.lessonBlock)}`
          : `${r.amount} кредит`,
        scheduleTarget: blockTarget(r.session?.lessonBlock),
      }));
    }

    case 'teacherPaymentLesson': {
      const rows = await prisma.teacherPaymentLesson.findMany({
        where: { id: { in: ids }, payment: { schoolId } },
        select: {
          id: true,
          payment: { select: { staffProfile: { select: { user: { select: { firstName: true, lastName: true } } } } } },
          lessonSession: { select: { date: true, status: true, lessonBlock: { select: blockSelect } } },
        },
      });
      return rows.map(r => ({
        id: r.id,
        label: personName(r.payment.staffProfile.user),
        sublabel: `Урок ${fmtDate(r.lessonSession.date)} (${r.lessonSession.status}) · группа ${r.lessonSession.lessonBlock.level}${blockNote(r.lessonSession.lessonBlock)}`,
        scheduleTarget: blockTarget(r.lessonSession.lessonBlock),
      }));
    }

    case 'lessonSession': {
      const rows = await prisma.lessonSession.findMany({
        where: { id: { in: ids }, schoolId },
        select: { id: true, date: true, status: true, lessonBlock: { select: blockSelect } },
      });
      return rows.map(r => ({
        id: r.id,
        label: `Урок ${fmtDate(r.date)}`,
        sublabel: `Группа ${r.lessonBlock.level} · статус ${r.status}${blockNote(r.lessonBlock)}`,
        scheduleTarget: blockTarget(r.lessonBlock),
      }));
    }

    case 'lessonBlock': {
      const rows = await prisma.lessonBlock.findMany({
        where: { id: { in: ids }, schoolId },
        select: {
          id: true, level: true, startTime: true, endTime: true, studentGroupId: true, deletedAt: true,
          studentGroup: { select: { deletedAt: true } },
          teacher: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
      });
      return rows.map(r => ({
        id: r.id,
        label: `Группа ${r.level}`,
        sublabel: r.teacher
          ? `Учитель: ${personName(r.teacher.user)} · ${r.startTime}–${r.endTime}`
          : `${r.startTime}–${r.endTime}`,
        scheduleTarget: blockTarget(r),
      }));
    }

    case 'teacherPayment': {
      const rows = await prisma.teacherPayment.findMany({
        where: { id: { in: ids }, schoolId },
        select: {
          id: true, period: true, lessonsCount: true,
          staffProfile: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
      });
      return rows.map(r => ({
        id: r.id,
        label: personName(r.staffProfile.user),
        sublabel: `Период ${r.period} · записано уроков: ${r.lessonsCount}`,
      }));
    }

    case 'studentProfile': {
      const rows = await prisma.studentProfile.findMany({
        where: { id: { in: ids }, user: { schoolId } },
        select: { id: true, credits: true, user: { select: { firstName: true, lastName: true } } },
      });
      return rows.map(r => ({
        id: r.id,
        label: personName(r.user),
        sublabel: `На балансе: ${r.credits} кредит(ов)`,
      }));
    }

    case 'invoice': {
      const rows = await prisma.invoice.findMany({
        where: { id: { in: ids }, schoolId },
        select: {
          id: true, status: true, totalAmount: true, paidAmount: true,
          studentProfile: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
      });
      return rows.map(r => ({
        id: r.id,
        label: personName(r.studentProfile.user),
        sublabel: `Инвойс #${r.id} · ${r.status} · оплачено ${r.paidAmount} из ${r.totalAmount}`,
      }));
    }

    case 'school': {
      const rows = await prisma.school.findMany({
        where: { id: { in: ids.filter(i => i === schoolId) } },
        select: { id: true, name: true },
      });
      return rows.map(r => ({ id: r.id, label: r.name }));
    }
  }
}
